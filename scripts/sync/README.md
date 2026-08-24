# GitHub / Gitee 双仓同步

## 本机提交后自动同步

安装受管 hook：

```powershell
node scripts/lib/ext-run.js khy-installer hooks
```

为当前仓库配置 Gitee 远端（地址只保存仓库 URL，不保存令牌）：

```powershell
git remote add gitee https://gitee.com/OWNER/REPOSITORY.git
```

令牌交给 Git Credential Manager 保存。首次推送时按提示输入 Gitee 用户名和令牌；也可以使用 SSH 远端：

```powershell
git remote set-url gitee git@gitee.com:OWNER/REPOSITORY.git
```

手动补推当前分支：

```bash
bash scripts/sync/push-mirrors.sh
```

hook 会尝试推送 `origin` 和 `gitee`，任一远端失败都会保留本地提交并输出警告，便于稍后执行手动补推。

## GitHub Actions 兜底

`.github/workflows/sync-gitee.yml` 会在 `main` / `master` 更新后从 GitHub 拉取同一提交并推送到 Gitee。仓库设置中配置：

- Actions secret：`GITEE_TOKEN`
- Actions variable：`GITEE_USER`（Gitee 用户名）
- Actions variable：`GITEE_REPOSITORY`（例如 `OWNER/REPOSITORY`）

完成配置后，即使本机离线或 hook 未安装，GitHub 仍会把主干同步到 Gitee。工作流也支持手动运行，用于补齐历史落后分支。
