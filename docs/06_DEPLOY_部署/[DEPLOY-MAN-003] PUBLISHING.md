# 把 khy 发布到 GitHub —— 起飞前检查

这些操作在仓库公开之前做一次。它们都不会自动执行——它们涉及你的凭据与
remote，所以要由你自己来跑。

## 1. 把 `github` remote 指向真实仓库

`github` remote 目前是占位符（`acme/khy-os`）。把它设为你的真实仓库，
并同步更新 README/徽章里的 slug（整个发布工具包中都用 `kodehu03/khy-os`
作占位符）。

```bash
git remote set-url github https://github.com/<your-username>/khy-os.git
git remote -v   # verify
```

然后把 `README.md`、`README.zh-CN.md` 以及
`.github/ISSUE_TEMPLATE/config.yml` + `SECURITY.md` 中的 `kodehu03/khy-os`
替换为 `<your-username>/khy-os`。

## 2. 把 GitLab token 从 remote URL 里挪走（卫生习惯）

`origin` remote 把一个 GitLab 个人访问令牌直接嵌进了 URL：

```
origin  https://oauth2:glpat-XXXXXXXX@gitlab.mindflow.com.cn/kodehu03/khy-quant.git
```

这**不会**随代码发布出去（它只存在于本地未被跟踪的 `.git/config` 中），
所以它不是通过仓库泄露。但 remote URL 里的 token 很容易通过
`git remote -v`、屏幕共享或复制出去的 `.git/config` 泄露。把它挪进凭据存储：

```bash
# 1) strip the token from the URL
git remote set-url origin https://gitlab.mindflow.com.cn/kodehu03/khy-quant.git

# 2) store the credential out-of-band (choose one)
#    a) cache helper (prompts once, remembers for a while)
git config --global credential.helper 'cache --timeout=3600'
#    b) or a ~/.netrc entry (chmod 600):
#       machine gitlab.mindflow.com.cn login oauth2 password glpat-XXXXXXXX
```

然后在 GitLab 里**轮换这个已暴露的 token**（Settings → Access Tokens →
撤销 + 重新签发），因为它已经以明文出现过。

## 3. 不要推送密钥

- 确认 `.env` 已被 gitignore（确实如此）且未被 stage：`git status --short | grep .env`
- 仓库自带的密钥脱敏正则（`glpat-…` 等）位于
  `services/backend/src/services/toolPipeline.js`——那些是检测器，不是
  密钥；保留它们。

## 4. 首次推送后的最终视觉检查

- 在 github.com 打开仓库：`assets/banner.svg` 是否在顶部渲染出来？
- CI / CodeQL 徽章是否为绿（在默认分支上把工作流跑一次）？
- 社交预览图是否已设置（Settings → Social preview）？
- About 描述 + topics 是否已设置（`docs/06_DEPLOY_部署/[DEPLOY-MAN-006] REPO_META.md`）？
