# 同步官方正式版标签与升级自定义版本

## 当前起点

- 自己的仓库：`origin`，指向 `war-ning/clash-verge-rev`。
- 官方仓库：`upstream`，指向 `clash-verge-rev/clash-verge-rev`。
- 重写分支：`codex/traffic-stats-rewrite`，从官方 `v2.5.8` 开始。
- 官方 v2.5.8 的代码提交：`4337bd85758d54d7b9044b2da3c9ac1176eae1f3`。
- 官方标签保存在本地 `upstream/v2.5.8`，用于与自己的标签区分。

这里的 `upstream/v2.5.8` 是我们保存官方标签的名称，不是官方分支。

## 1. 取回某个已确认正式发布的版本

先在官方 Releases 页面确认版本确实为所需正式版。不要仅按标签名称排序选第一个，因为其中可能有预发布版或滚动构建标签。

以 v2.5.8 为例，在仓库目录执行：

```powershell
git fetch --no-tags upstream "refs/tags/v2.5.8:refs/tags/upstream/v2.5.8"
git show --no-patch --format=fuller "upstream/v2.5.8^{commit}"
```

这会拉取该版本的代码和必要历史，但不会切换当前分支或修改工作文件。以后把两处版本号改为已确认的新正式版即可。

如果想把官方所有标签同步到本地、同时与自己的标签区分：

```powershell
git fetch --no-tags upstream "refs/tags/*:refs/tags/upstream/*"
```

这条命令也会包含开发标签，不表示全部都适合日常使用。若某个已存在的标签发生冲突，先核对原因，不直接强制覆盖。

## 2. 把标签备份到自己的 GitHub 仓库

代码分支与标签分别推送。取回官方标签后，推送需要保留的那个：

```powershell
git push origin refs/tags/upstream/v2.5.8
```

自己的 GitHub 仓库会显示 `upstream/v2.5.8` 标签。它仍指向官方原版，不含自己的统计功能；自定义代码保存在自定义分支中。

## 3. 首次从正式版开始开发

本次已经完成分支准备，不需要再次执行建分支命令。若以后从零准备其他功能，可参考：

```powershell
git switch -c codex/traffic-stats-rewrite upstream/v2.5.8
git push -u origin codex/traffic-stats-rewrite
```

分支已经存在时不要重复建立；进入它所在的工作目录继续开发即可。不要直接在标签位置长期开发，因为标签本身不会随工作前进。

## 4. 后续升级到另一个官方正式版

以下用变量表示未来已确认发布的正式版；不要原样保留占位文字执行。开始前，保存当前工作并确认当前处于自己的统计维护分支。

```powershell
$releaseTag = '替换为已确认的正式版标签'
$upgradeBranch = '替换为本次升级分支名'
git fetch --no-tags upstream "refs/tags/${releaseTag}:refs/tags/upstream/${releaseTag}"
git switch -c $upgradeBranch
git merge --no-ff "upstream/$releaseTag"
```

升级分支从当前自定义版本出发，所以统计改动仍在，再引入官方版本的增量。遇到冲突先理解并解决，确认原系统和统计功能都正常，再完成交付。

验证通过后，提交冲突处理和必要适配，再将升级结果合入统计维护分支并推送，生成自己的安装包。不要把自定义分支直接替换为官方标签的内容。

## 5. 两类版本分别保存

- `upstream/v2.5.8`：官方原版，供追溯基础版本。
- 自定义分支或自定义发布标签：官方基础加自己的统计功能，作为自己的安装包来源。

同步源码标签不等于已经完成安装包升级。自己的更新渠道、安装包和统计记录保留规则，仍按长期维护计划执行。

## 来源

- [官方 Releases](https://github.com/clash-verge-rev/clash-verge-rev/releases)
- [Git：fetch](https://git-scm.com/docs/git-fetch)
- [Git：merge](https://git-scm.com/docs/git-merge)
