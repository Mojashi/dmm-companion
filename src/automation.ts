import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Companion } from "./coach";
import { type Lesson, safeError } from "./domain";
import type { ReviewMail } from "./email";
import { atomicJson, type Store } from "./store";

export const automationConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  since: z.iso.datetime(),
  intervalMinutes: z.number().int().min(5).max(1440),
  minimumAgeMinutes: z.number().int().min(30).max(1440),
  maxPerRun: z.number().int().min(1).max(20),
  delivery: z.literal("mac"),
});
export type AutomationConfig = z.infer<typeof automationConfigSchema>;
type Attempt = { attempts: number; retryAt?: string; error?: string };
type DeliveryAttempt = Attempt & { deliveredAt?: string };
type ReviewJob = {
  analysis: Attempt;
  delivery: DeliveryAttempt & { file?: string };
  email?: DeliveryAttempt;
};
export type AutomationState = {
  version: 1;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastCompletedAt?: string;
  error?: string;
  alert?: { message: string; at: string };
  jobs: Record<string, ReviewJob>;
};
export type ReviewDelivery = {
  deliver(lesson: Lesson): Promise<{ file: string }>;
  alert(message: string): Promise<void>;
};
type AutomationWorker = Pick<Companion, "status" | "sync" | "enqueue" | "idle">;

export function readAutomationConfig(path: string): AutomationConfig | undefined {
  return existsSync(path) ? automationConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

export function reviewIsDue(lesson: Lesson, config: AutomationConfig, now: number): boolean {
  const started = Date.parse(lesson.date);
  return (
    lesson.attended &&
    Boolean(lesson.bookingId) &&
    started >= Date.parse(config.since) &&
    started <= now - config.minimumAgeMinutes * 60_000
  );
}

export class AutomaticReviews {
  private running = false;
  readonly state: AutomationState;
  constructor(
    private readonly store: Store,
    private readonly worker: AutomationWorker,
    private readonly delivery: ReviewDelivery,
    private readonly mail: ReviewMail,
    private readonly now = Date.now,
  ) {
    this.state = existsSync(store.path("automation-state.json"))
      ? JSON.parse(readFileSync(store.path("automation-state.json"), "utf8"))
      : { version: 1, jobs: {} };
    if (this.state.version !== 1) throw new Error("未対応の自動振り返りの保存形式です。");
  }
  snapshot() {
    return {
      config: readAutomationConfig(this.store.path("automation.json")),
      running: this.running,
      ...this.state,
    };
  }
  start(): () => void {
    const tick = () => {
      void this.run().catch((error) => {
        this.state.error = safeError(error);
        this.save();
        console.error(`自動振り返り: ${this.state.error}`);
      });
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }
  async run(force = false): Promise<void> {
    const config = readAutomationConfig(this.store.path("automation.json"));
    if (!config?.enabled || this.running || this.worker.status.busy) return;
    if (!force && this.state.nextCheckAt && Date.parse(this.state.nextCheckAt) > this.now()) return;
    this.running = true;
    this.state.lastCheckedAt = new Date(this.now()).toISOString();
    this.state.nextCheckAt = new Date(this.now() + config.intervalMinutes * 60_000).toISOString();
    delete this.state.error;
    this.save();
    try {
      await this.refreshLessons();
      await this.generateReviews(config);
      await this.deliverReviews(config);
      await this.reportProblem();
      this.state.lastCompletedAt = new Date(this.now()).toISOString();
    } catch (error) {
      this.state.error = safeError(error);
    } finally {
      this.running = false;
      // Long analyses must not immediately trigger another crawl when they finish.
      this.state.nextCheckAt = new Date(this.now() + config.intervalMinutes * 60_000).toISOString();
      this.save();
    }
  }
  private async refreshLessons() {
    await this.worker.sync();
    if (this.worker.status.error) this.state.error = this.worker.status.error;
  }
  private async generateReviews(config: AutomationConfig) {
    const due = this.store.library.lessons
      .filter((lesson) => reviewIsDue(lesson, config, this.now()) && !lesson.feedback)
      .filter((lesson) => this.canAttempt(this.job(lesson.id).analysis))
      .slice(0, config.maxPerRun);
    for (const lesson of due) {
      if (!this.isEnabled()) break;
      const attempt = this.job(lesson.id).analysis;
      this.beginAttempt(attempt);
      try {
        this.worker.enqueue([lesson.id]);
        await this.worker.idle();
        if (!lesson.feedback) throw new Error(lesson.error ?? "振り返りが生成されませんでした。");
        delete attempt.error;
        delete attempt.retryAt;
      } catch (error) {
        attempt.error = safeError(error);
        this.state.error = `${lesson.teacher}先生との振り返り: ${attempt.error}`;
      }
      this.save();
    }
  }
  private async deliverReviews(config: AutomationConfig) {
    await this.deliverEach(
      config,
      "振り返りの配信",
      (job) => job.delivery,
      async (lesson, attempt) => {
        attempt.file = (await this.delivery.deliver(lesson)).file;
      },
    );
    const emailSince = this.mail.enabledAt();
    if (emailSince)
      await this.deliverEach(
        config,
        "振り返りのメール送信",
        (job) => {
          job.email ??= { attempts: 0 };
          return job.email;
        },
        (lesson) => this.mail.send(lesson),
        // Reviews already notified before email was turned on are not mailed retroactively.
        (job) => !(job.delivery.deliveredAt && job.delivery.deliveredAt < emailSince),
      );
  }
  private async deliverEach<T extends DeliveryAttempt>(
    config: AutomationConfig,
    label: string,
    attemptOf: (job: ReviewJob) => T,
    send: (lesson: Lesson, attempt: T) => Promise<void>,
    eligible: (job: ReviewJob) => boolean = () => true,
  ) {
    const ready = this.store.library.lessons
      .filter((lesson) => reviewIsDue(lesson, config, this.now()) && lesson.feedback)
      .filter((lesson) => {
        const job = this.job(lesson.id);
        if (!eligible(job)) return false;
        const attempt = attemptOf(job);
        return !attempt.deliveredAt && this.canAttempt(attempt);
      })
      .slice(0, config.maxPerRun);
    for (const lesson of ready) {
      if (!this.isEnabled()) break;
      const attempt = attemptOf(this.job(lesson.id));
      if (attempt.deliveredAt || !this.canAttempt(attempt)) continue;
      this.beginAttempt(attempt);
      try {
        await send(lesson, attempt);
        attempt.deliveredAt = new Date(this.now()).toISOString();
        delete attempt.error;
        delete attempt.retryAt;
      } catch (error) {
        attempt.error = safeError(error);
        this.state.error = `${label}: ${attempt.error}`;
      }
      this.save();
    }
  }
  private async reportProblem() {
    if (!this.state.error) {
      for (const lesson of this.store.library.lessons) {
        const job = this.state.jobs[lesson.id];
        if (!lesson.feedback && job?.analysis.error) {
          this.state.error = `${lesson.teacher}先生との振り返り: ${job.analysis.error}`;
          break;
        }
        if (!job?.delivery.deliveredAt && job?.delivery.error) {
          this.state.error = `振り返りの配信: ${job.delivery.error}`;
          break;
        }
        if (this.mail.enabledAt() && !job?.email?.deliveredAt && job?.email?.error) {
          this.state.error = `振り返りのメール送信: ${job.email.error}`;
          break;
        }
      }
    }
    const error = this.state.error;
    if (!error) {
      delete this.state.alert;
      return;
    }
    const last = this.state.alert;
    if (last?.message === error && this.now() - Date.parse(last.at) < 86400_000) return;
    await this.delivery.alert(error);
    this.state.alert = { message: error, at: new Date(this.now()).toISOString() };
  }
  private isEnabled() {
    return readAutomationConfig(this.store.path("automation.json"))?.enabled === true;
  }
  private job(id: string): ReviewJob {
    this.state.jobs[id] ??= { analysis: { attempts: 0 }, delivery: { attempts: 0 } };
    return this.state.jobs[id];
  }
  private canAttempt(attempt: Attempt) {
    return !attempt.retryAt || Date.parse(attempt.retryAt) <= this.now();
  }
  private beginAttempt(attempt: Attempt) {
    attempt.attempts++;
    const delay = Math.min(24 * 60, 10 * 2 ** Math.min(attempt.attempts - 1, 8));
    attempt.retryAt = new Date(this.now() + delay * 60_000).toISOString();
    this.save();
  }
  private save() {
    atomicJson(this.store.path("automation-state.json"), this.state);
  }
}
