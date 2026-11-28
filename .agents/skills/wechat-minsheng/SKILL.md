---
name: wechat-minsheng
description: >-
  Entry point for WeChat 公众号「民生写实」articles about ordinary people's lives
  (money, marriage, jobs, kids, elder care, family): topic ideation, drafting,
  排版 with the editor's layout themes and components, and 封面 / 配图 / 插图 /
  IP 形象. It orchestrates khazix-writer (long-form craft) and human-writing
  (truthfulness, material threshold, prose bans). Use this instead of calling
  those two directly whenever the user asks for 民生 / 写实 / 爆款选题 / 10W+
  topics or an article on these subjects.
---

# 公众号「民生写实」

这是账号的入口。文章怎么写交给两个通用 skill，这里只管这个号和这个编辑器独有的东西。

| 需要什么 | 读哪里 |
| --- | --- |
| 叙述者是谁 | `references/account.md` |
| 选题、标题、往大处想 | `references/topics.md` |
| 民生材料去哪找、账怎么算 | `references/material.md` |
| 公众号长文的结构和手法 | `khazix-writer` |
| 真实性、材料门槛、文字禁令、改稿 | `human-writing` |
| 排版 | `references/layout.md` |
| 配图 | `references/illustration.md` |
| 降 AI 检测率 | `references/detector.md`，只在用户要求时读 |

## 流程

1. 读 `account.md`，后面每一步都用这个叙述者
2. 选题：读 `topics.md`，再用 `khazix-writer` 的 HKR 检查过一遍
3. 找材料：读 `material.md`，照 `human-writing` 的材料门槛和 `references/reality.md` 清点。不问用户，缺材料就去搜
4. 写：按 `khazix-writer` 的流程写，民生稿一般是「现象解读型」；中文照 `human-writing` 和它的 `references/forum-prose.md`。开头从一件具体的事切进去，让读者第一眼觉得这件事就在自己身边
5. 改：过 `khazix-writer` 的 `references/quality-check.md` 四层，再照 `human-writing` 的 `references/revision.md` 改。环境能跑 Python 就跑 `python3 -I <human-writing 目录>/scripts/check_prose.py <成稿文件>`，硬禁令清零
6. 排版：读 `layout.md`
7. 配图：用户要封面或插图时读 `illustration.md`
8. 用户要求降低 AI 检测率时，最后读 `detector.md` 再改一遍

## 冲突听谁的

用户这次说的话 > 本 skill 和它的 references > `human-writing` > `khazix-writer`。已知的冲突这样定：

| 事项 | 定为 |
| --- | --- |
| 叙述者 | 照 `account.md`。`khazix-writer` 自检里「像不像卡兹克在说话」换成「像不像这个叙述者在说话」，不用它示例里的个人经历和 AI 行业背景 |
| 提问 | 不问用户。两个 skill 里「先问三个问题」的步骤一律改成去搜；搜不到就按 `human-writing` 收窄题目、缩短篇幅 |
| 待补标记 | 不留，成稿要能直接发 |
| 篇幅 | 用户没说就写 2000 到 3500 字；材料不够按 `human-writing` 缩短，不凑字 |
| 小标题、编号、列表 | 都不用，三方一致；清单类题目的写法见 `layout.md` |
| 结尾 | 说完就停，停在一个事实或一个问题上，可以呼应开头；不硬升华，不号召，不加点赞关注之类的引导 |
| 引号 | 正文用「」 |
| 强调 | 照 `layout.md` 少量加粗、下划线，不大段加粗 |
| 配图位置 | 不写「图片」占位，照 `illustration.md` |
| 来源 | 正文不放链接，文末用参考资料卡 |

## 交付

只交正文。回复里另起一行，按 `layout.md` 推荐一套排版主题和配色。
