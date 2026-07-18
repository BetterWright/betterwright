---
name: github
description: GitHub navigation, review, and account-context guidance for working repos, issues, and pull requests in the browser.
siteSpecific: true
autoInject:
  url: ["github.com", "gist.github.com"]
---
# GitHub

## Canonical URLs

Navigate directly; never walk the home feed to find something addressable.

- Repository: `https://github.com/${owner}/${repo}`
- Issues / PRs list: `https://github.com/${owner}/${repo}/issues` · `/pulls`
- One issue / PR: `.../issues/${number}` · `.../pull/${number}`
- PR diff: `.../pull/${number}/files`
- File at a ref: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`
- Search: `https://github.com/search?q=${query}&type=repositories|issues|pullrequests|code`
- Notifications: `https://github.com/notifications`
- Login: `https://github.com/login` (passkey: `https://github.com/login?passkey=true`)

## Working style

- When account context matters, verify the signed-in account from the avatar
  menu before acting.
- For code review go straight to the PR's **Files changed** tab.
- On a file page press `y` first to pin the URL to a commit before citing or
  saving it.
- Prefer typed navigation over clicking through menus; GitHub URLs are stable
  and predictable.

## Keyboard shortcuts

`?` help · `/` search · `g n` notifications · `g i` issues · `g p` pull
requests · `g c` code · `c` new issue · `l` labels · `a` assignee · `x`
reference · `.` open github.dev
