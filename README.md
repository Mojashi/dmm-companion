# DMM Companion

DMM英会話の録音から、言い換え・復習表現・次のレッスンで使う練習文を作るローカルアプリです。Bunでコンパイルした`dmm`にサーバーとReactの振り返りページを同梱します。

## 使い方

```sh
dmm setup
# メールアドレス: ...
# パスワード: ... （非表示）

dmm
```

`setup`は入力したメールアドレス・パスワードでDMMへログインし、成功したセッションをローカルに保存して完了します。認証処理はバックグラウンドで行われます。通常のブラウザでログイン操作をする必要はありません。

再設定時も入力したパスワードで認証するため、認証用ブラウザは毎回新しいプロファイルで起動し、処理が終わったら削除します。

`dmm`は振り返りページを開き、保存済みセッションで全月の履歴と録音の有無を同期します。「このレッスンを振り返る」または一括分析ボタンで、必要な録音をダウンロードしてGeminiによる分析を開始できます。表現ノートでは検索と復習済みの記録ができます。

```sh
dmm sync                 # 新しい履歴・録音一覧の同期
dmm sync --full          # 全月を取り直す
dmm analyze all          # 未分析レッスンを順番に分析
dmm analyze LESSON_ID    # 1レッスンを分析
dmm --no-open            # ブラウザを自動で開かず起動
dmm --port 4318          # ポート指定
dmm --data-dir /path/to/data
```

ログインが切れたら`dmm setup`を再実行してください。起動中のアプリに対しても`dmm setup`と`dmm sync`を実行できます。

## 自動生成・配信

```sh
brew install terminal-notifier  # Mac通知に使用（3以上。2の場合はbrew upgrade terminal-notifier）
dmm auto test                  # 初回の通知許可・テスト通知
dmm auto doctor                # 通知許可・バナー表示の設定を確認
dmm auto enable                # 自動起動・生成・通知を有効にする
dmm auto status                # 最終確認時刻、エラー、配信済みの記録
dmm auto run                   # 今すぐ確認する
dmm auto disable               # 自動起動・生成・通知を停止する
dmm auto email                 # 振り返りをgwsのGmailからメールでも送る
dmm auto email off             # メール配信を停止する
```

Macのログイン時にバックグラウンドで起動し、10分ごとにレッスンを確認します。ターミナルや振り返りページを開いておく必要はありません。すでに手動起動中の`dmm`があればそのプロセスが自動実行を担当し、終了後はバックグラウンドのプロセスが引き継ぎます。Macがスリープ・電源OFFの間は処理できません。起動・復帰後に未処理分を確認します。

初回設定時の7日前以降と、今後の受講済みレッスンが対象です。録音の公開を待つため、開始から45分以上経過したレッスンを分析します。標準の25分レッスンでは終了後20〜30分ほどで検出し、音声準備・Gemini分析の後に通知します。1回の確認で生成・配信する件数はそれぞれ最大3件です。

```sh
dmm auto enable --since 2026-09-01  # 過去分も含めて対象期間を指定（日本時間）
dmm auto enable --interval 15      # 確認間隔を15分に変更
```

通知にはレッスンの題名と重点を載せ、クリックすると該当レッスンの振り返りページが開きます。全文は`deliveries/レッスンID.md`にも保存します。要点・重点3つ・言い直し例・次回試すことを読み返せます。初回は`dmm auto test`で通知を許可します。すでに拒否されている場合は「システム設定 → 通知 → terminal-notifier」で「通知を許可」をオンにし、スタイルを「バナー」か「通知パネル」にしてください。

通知が来ない場合は`dmm auto doctor`を実行してください。通知許可・表示スタイルを有効化時と送信時に診断し、拒否・表示無効・時刻指定要約の場合はエラーとして再試行対象に残します。terminal-notifier 2は通知拒否でも成功を返すため利用できません。送信済みはMacによる受け付けの記録であり、画面表示や既読の保証ではありません。集中モードの設定は尊重します。

### メール配信

`dmm auto email`で、Mac通知に加えて振り返り全文（`deliveries/レッスンID.md`と同じ内容）をメールでも送ります。送信には[gws](https://github.com/googleworkspace/cli)がログイン済みのGmailアカウントを使うので、パスワードは保存しません（`gws auth login`でGmailの送信権限が必要）。送信先を省略するとgwsのアカウント自身に送ります。設定時にテストメールを送り、送れた場合だけ設定を`email.json`に保存します。

```sh
dmm auto email                   # gwsのアカウント宛に送る
dmm auto email me@example.com    # 送信先を指定
```

メールで送るのは、設定より後に通知した振り返りです。設定前に通知済みの分はさかのぼって送りません。通知とメールは別々に送信済みを記録するので、メールの失敗で通知が重複することも、その逆もありません。メールの失敗は通知と同じ間隔で再試行し、Mac通知と`dmm auto status`でエラーを確認できます。起動中のバックグラウンドプロセスにも次回の確認から反映されます。バックグラウンドは`dmm auto enable`時のPATHで`gws`を探すので、gwsを後から入れた場合は`dmm auto enable`を再実行してください。

分析と配信の進捗は別々に保存します。配信失敗時にGemini分析をやり直すことはありません。通信失敗・録音未公開時は10分から最大24時間の間隔で再試行します。送信済みと記録した振り返りは再送せず、Mac通知のIDもレッスンごとに固定して同じ通知の重複表示を抑えます。資格情報の期限切れなどはMac通知と`dmm auto status`で確認でき、`dmm setup`で再ログインできます。

設定は`automation.json`、確認・生成・配信の記録は`automation-state.json`、ログは`logs/`です。LaunchAgentは`~/Library/LaunchAgents/com.dmm-companion.auto.<保存先の識別子>.plist`に登録します。実行ファイルの絶対パスと設定時のPATHを保存するので、バイナリの場所や外部ツールの配置を変えたときは`dmm auto enable`を再実行してください。

## 必要なもの

- Google Chrome: DMMのログインフォームと認証用JavaScriptをバックグラウンドで実行します。通常使っているプロファイルは使いません。
- `agy`: ログイン済みのCLI。`agy -p "…" --model gemini-4-argon-high --output-format json`で分析します。
- `ffmpeg` / `ffprobe`: 話者ごとに分かれた録音の復元と時刻合わせ。

```sh
brew install ffmpeg
```

アプリ実行時にBun・Node.js・node_modulesは不要です。上の外部ツールは別途必要です。フォントをオンライン取得できない場合はローカルフォントで表示します。

## ビルド・インストール

```sh
bun install
bun run typecheck
bun run lint
bun test
bun run build
install -m 755 dist/dmm ~/.local/bin/dmm
```

`dist/dmm`が実行ファイルです。Bunの[単一実行ファイル機能](https://bun.sh/docs/bundler/executables)でUIとランタイムを埋め込んでいます。別OS向けにはBunの`--target`を指定してください。

## 保存先と再開

既定の保存先は`~/.dmm-companion/`です。

| パス | 内容 |
| --- | --- |
| `credentials.json` | メールアドレスとログインセッション。パスワードは保存しません |
| `login-browser/attempt-*` | 認証中だけ使用するプロファイル。成功・失敗時ともに削除 |
| `library.json` | 履歴・分析結果・復習済みの記録 |
| `manifest.json` | 取得日時・条件・取得月・件数 |
| `sources/` | 取得した履歴・録音メタデータ |
| `chunks/` | 録音の元データ。署名URL更新後も再利用 |
| `audio/` | 時刻を合わせて復元したMP3 |
| `analyses/` | Geminiの生出力と検証済みの分析結果 |
| `work/` | 再作成可能な音声処理ファイル |

保存ディレクトリは`0700`、資格情報とJSONは`0600`です。取得結果は各ページ・各レッスンで保存し、中断後に再実行できます。初回は全月、2回目以降は未取得の月と直近2か月を同期します。成功済みの分析は再実行しません。データ・HAR・資格情報はGitに含めません。

## 分析の根拠と取得範囲

`agy`の`view_file`は音声をそのままGeminiに渡すため、文法・表現に加えて発音・リズム・イントネーションも振り返ります。Geminiが文字起こししか受け取れなかった場合は画面にその旨を表示し、発音は評価しません。頭出しの時刻はGeminiが音声から特定したおおよその位置です。録音の範囲外の時刻は採用せず、その項目には頭出しボタンを表示しません。元の録音は再生できます。

履歴の同期完了と、録音の取得可否は別々に管理します。録音の保存期限を過ぎたレッスン、未受講のレッスン、録音URLのない古い履歴なども一覧に残します。全月を取得し終えるまでは「全履歴は未確認」と表示します。

DMM側で追加認証・CAPTCHAが要求された場合は、成功扱いにせずエラーにします。ログインフォームや非公開APIが変わった場合は追従が必要です。

## 開発

```sh
bun run dev -- --no-open
```

トップレベルの流れは「ログインを設定 → 履歴を同期 → 録音を準備 → Geminiで振り返り → 復習を記録」です。認証・HAR解析・録音復元・AI呼び出し・保存・UIを分離しています。

- `src/login.ts`, `src/prompt.ts`: CLIでの入力と認証
- `src/dmm.ts`, `src/importer.ts`: 履歴・録音API、月単位の同期
- `src/audio.ts`: MediaRecorderの断片を復元し、絶対時刻で音声を合成
- `src/coach.ts`: Gemini分析・キュー・失敗の管理
- `src/store.ts`: 永続化と中断後の復旧
- `src/server.ts`, `src/web/`: localhost限定のAPIと振り返りページ

通信調査の再現用に`dmm import-har path.har`も残していますが、通常の利用では不要です。

認証の実機テストは、開発用HARから認証情報を読み、実際の端末入力でコンパイル済みCLIを2回実行します。保存済みセッションによる履歴・録音APIへのアクセス、パスワード非表示、プロファイル削除まで検証します（Pythonの`pexpect`が必要）。

```sh
python3 scripts/test-setup.py /path/to/local.har \
  --binary dist/dmm \
  --data-dir .local-data/setup-test \
  --report .local-data/setup-verification.json
```

認証情報は出力しません。検証結果と資格情報は指定したローカルディレクトリに保存します。
