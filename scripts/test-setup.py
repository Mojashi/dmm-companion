"""Exercise the compiled CLI with a real PTY and credentials from a local HAR.

Requires pexpect. Never prints credentials; use only a HAR belonging to the account being tested.
"""

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import time
import urllib.parse
import urllib.request

import pexpect


def read_identity(har_path):
    har = json.loads(har_path.read_text())
    identity = None
    for entry in har["log"]["entries"]:
        request = entry["request"]
        url = urllib.parse.urlsplit(request["url"])
        if (
            url.scheme == "https"
            and url.hostname == "accounts.dmm.com"
            and url.path.endswith("/password/authenticate")
        ):
            form = urllib.parse.parse_qs(request.get("postData", {}).get("text", ""))
            if form.get("login_id") and form.get("password"):
                identity = (form["login_id"][0], form["password"][0])
    if identity is None:
        raise RuntimeError("HARにパスワード認証のPOSTがありません")
    return identity


def verify_session(root):
    credentials = json.loads((root / "credentials.json").read_text())
    request = urllib.request.Request(
        "https://eikaiwa.dmm.com/lesson/",
        headers={"Cookie": credentials["dmmCookie"]},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        page = response.read().decode()
        assert response.status == 200 and 'name="history_date"' in page, "履歴の認証に失敗"
    library = json.loads((root / "library.json").read_text())
    booking = next((lesson.get("bookingId") for lesson in library["lessons"] if lesson.get("bookingId")), None)
    path = f"/api/lesson_bookings/{booking}/combined" if booking else "/api/users/current"
    headers = {"Origin": "https://eikaiwa.dmm.com", "Accept": "application/json"}
    for field, name in [("bearer", "Authorization"), ("apiCookie", "Cookie"), ("viewmodel", "x-viewmodel-versions")]:
        if credentials.get(field):
            headers[name] = credentials[field]
    with urllib.request.urlopen(
        urllib.request.Request("https://api.engoo.com" + path, headers=headers), timeout=60
    ) as response:
        assert response.status == 200, "録音APIの認証に失敗"
        assert "data" in json.load(response), "録音APIの応答が不正"
    assert "password" not in credentials, "パスワードが保存されています"
    assert (root / "credentials.json").stat().st_mode & 0o777 == 0o600
    assert not list((root / "login-browser").glob("attempt-*")), "認証プロファイルが残っています"
    return credentials["savedAt"]


def run_setup(binary, root, identity):
    email, password = identity
    started = time.monotonic()
    child = pexpect.spawn(str(binary), ["setup", "--data-dir", str(root)], encoding="utf-8", timeout=180)
    output = ""
    try:
        child.expect_exact("メールアドレス: ")
        child.sendline(email)
        child.expect_exact("パスワード: ")
        child.sendline(password)
        child.expect(pexpect.EOF)
        output = child.before
        child.close()
        assert password not in output, "パスワードが画面に表示されました"
        if child.exitstatus != 0:
            raise RuntimeError(output.replace(password, "[REDACTED]").replace(email, "[EMAIL]"))
    except (pexpect.TIMEOUT, pexpect.EOF):
        # Pexpect's default exception contains terminal buffers, which can contain credentials.
        raise RuntimeError("CLI入力または認証が完了しませんでした") from None
    finally:
        if child.isalive():
            child.close(force=True)
    return {
        "exit": child.exitstatus,
        "elapsedSeconds": round(time.monotonic() - started, 2),
        "passwordEchoed": False,
        "sessionSavedAt": verify_session(root),
        "historyAuthenticated": True,
        "recordingApiAuthenticated": True,
        "profileRemoved": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("har", type=pathlib.Path)
    parser.add_argument("--binary", type=pathlib.Path, default=pathlib.Path("dist/dmm"))
    parser.add_argument("--data-dir", type=pathlib.Path, required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()
    assert args.repeat >= 1
    identity = read_identity(args.har)
    report = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "binarySha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        "dataDir": str(args.data_dir.resolve()),
        "cases": [],
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    for number in range(1, args.repeat + 1):
        print(f"Running real CLI setup {number}/{args.repeat}", flush=True)
        result = run_setup(args.binary.resolve(), args.data_dir.resolve(), identity)
        if report["cases"]:
            assert result["sessionSavedAt"] != report["cases"][-1]["sessionSavedAt"], "資格情報が更新されていません"
        report["cases"].append(result)
        with open(args.report, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    print("PASS", str(args.report))


if __name__ == "__main__":
    main()
