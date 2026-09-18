#!/usr/bin/env python3
"""
Založí issues v GitHubu z ISSUES.md.

Použití:
    export GH_TOKEN=ghp_...            # PAT s právem 'repo' (nebo Fine-grained: Issues RW)
    python3 gh_issues.py --dry-run     # vypíše, co by vytvořil
    python3 gh_issues.py               # vytvoří labely, milníky a issues

Volby:
    --repo owner/name   výchozí petrbocek/volley_stats
    --file ISSUES.md    výchozí ISSUES.md ve stejném adresáři
    --only 1,2,5        vytvoří jen vybraná čísla issue
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"

LABEL_COLORS = {
    "security": "d73a4a", "db": "0e8a16", "bug": "d73a4a", "data-loss": "b60205",
    "ux": "1d76db", "volleyball": "5319e7", "refactor": "fbca04", "feature": "0e8a16",
    "infra": "c5def5", "cleanup": "ededed", "epic": "5319e7",
    "P0": "b60205", "P1": "d93f0b", "P2": "fbca04", "P3": "ededed",
}


def req(token, method, path, payload=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token}")
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            body = resp.read().decode()
            return resp.status, json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def parse(path):
    """Vrátí [(cislo, titulek, labely, milnik, telo)] z ISSUES.md."""
    text = open(path, encoding="utf-8").read()
    milestone = None
    issues = []
    # rozsekat na bloky podle '## ' (milník) a '### #N ' (issue)
    chunks = re.split(r"^(##{1,2} .*)$", text, flags=re.M)
    i = 1
    while i < len(chunks):
        head, body = chunks[i].strip(), chunks[i + 1]
        if head.startswith("### "):
            m = re.match(r"### #(\d+)\s+(.*)", head)
            if m:
                num, title = int(m.group(1)), m.group(2).strip()
                lm = re.search(r"^`labels:\s*(.*?)`\s*$", body, flags=re.M)
                labels = [x.strip() for x in lm.group(1).split(",")] if lm else []
                if lm:
                    body = body.replace(lm.group(0), "", 1)
                body = re.sub(r"\n---\s*$", "", body.strip()).strip()
                issues.append((num, title, labels, milestone, body))
        elif head.startswith("## "):
            milestone = head[3:].strip()
        i += 2
    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="petrbocek/volley_stats")
    ap.add_argument("--file", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "ISSUES.md"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token and not args.dry_run:
        sys.exit("Chybí GH_TOKEN. export GH_TOKEN=ghp_...")

    issues = parse(args.file)
    if args.only:
        want = {int(x) for x in args.only.split(",")}
        issues = [i for i in issues if i[0] in want]
    if not issues:
        sys.exit("Z ISSUES.md se nic nenačetlo, zkontroluj cestu a formát.")

    print(f"Načteno {len(issues)} issues z {args.file}")
    if args.dry_run:
        for num, title, labels, ms, body in issues:
            print(f"  #{num:<3} [{ms or '-'}] {title}  labels={','.join(labels)}  ({len(body)} B)")
        return

    # labely
    used = sorted({l for i in issues for l in i[2]})
    for name in used:
        code, _ = req(token, "POST", f"/repos/{args.repo}/labels",
                      {"name": name, "color": LABEL_COLORS.get(name, "ededed")})
        print(f"  label {name}: {'ok' if code == 201 else 'už existuje' if code == 422 else code}")

    # milníky
    code, existing = req(token, "GET", f"/repos/{args.repo}/milestones?state=all&per_page=100")
    have = {m["title"]: m["number"] for m in (existing or [])}
    for title in sorted({i[3] for i in issues if i[3]}):
        if title in have:
            continue
        code, m = req(token, "POST", f"/repos/{args.repo}/milestones", {"title": title})
        if code == 201:
            have[title] = m["number"]
            print(f"  milník {title}: ok")
        else:
            print(f"  milník {title}: {code} {m}")

    # issues
    created = 0
    for num, title, labels, ms, body in issues:
        payload = {"title": title, "body": body, "labels": labels}
        if ms and ms in have:
            payload["milestone"] = have[ms]
        code, res = req(token, "POST", f"/repos/{args.repo}/issues", payload)
        if code == 201:
            created += 1
            print(f"  #{num} -> {res['html_url']}")
        else:
            print(f"  #{num} CHYBA {code}: {res}")
    print(f"Hotovo, vytvořeno {created}/{len(issues)}.")


if __name__ == "__main__":
    main()
