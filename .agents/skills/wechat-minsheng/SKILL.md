---
name: wechat-minsheng
description: >-
  Topic ideation, drafting, and cover / illustration style for WeChat
  公众号「民生写实」articles about ordinary people's lives (money, marriage,
  jobs, kids, elder care, family). Use when the user asks for 民生 / 写实 /
  爆款选题 / 公众号文章 / 10W+ topics, a draft following the 6-step framework,
  or 封面 / 配图 / 插图 / IP 形象 for such an article.
---

# 公众号「民生写实」写作 Skill

> 赛道定位：不追热点，专注「大环境现状」与「普通人生活」。标题短小吸睛，内容不求高深但极具共鸣。

## 何时调用

- 找民生写实类选题，或把一个大话题拆成多篇
- 按 6 步框架写公众号文章
- 给文章配封面图和插图

## 赛道要点

- **话题常青**：时代会变，普通人的核心焦虑永远围绕 **钱、婚姻、工作、孩子、养老、家庭关系**。例：《年轻人为什么越来越难结婚？》《家庭存款的 5 个等级，普通人在哪一级能躺平？》《为什么年轻人宁愿送外卖，也不去制造业工厂上班？》
- **受众广**：像《月薪 5000 到底该不该买车？》这类选题，上班族、宝妈、刚毕业的年轻人都能看。能代入自己经历的人越多，共鸣越强，评论区越热闹。
- **一个大话题反复拆解**：只换切入角度。例「男人娶不到老婆」→ 农村男青年为什么难结婚？/ 彩礼压力 / 为什么工资不低还是找不到对象？/ 父母催婚、买房压力、择偶标准、年龄焦虑等。
- **逼用户表达态度**：不是给用户答案。把大家的现状写出来，评论区就会有人讲经历、有人站队。

## 找选题

原则：别只做「你想写的」，要挖出「现在人共同的痛点」。

1. **盯同行爆款**：整理对标账号近期 5W+、10W+ 的文章，分析背后抓住的**矛盾点**和**痛点切入口**，学切口不抄表面。例：《女人结婚以后该不该管钱》，引发讨论的不是"管钱"，而是"家庭里的话语权"。
2. **从自己身边挖**：同事辞职去送外卖、朋友结婚几年还在还债、父母总觉得存款放银行才踏实……自己经历过、听过、见过的事天然带有细节，有细节才有「活人感」。
3. **用 AI 生成**：挑几个对标账号的爆款标题，批量生成同风格选题，再人工筛选优化。参考提示词：

   ```text
   钱难挣，新的攀比又出现了
   很多单位，发不出大工资了
   新型返贫三件套，一件都不沾
   大家消费降级到什么程度
   女孩单身越来越多，说明了什么问题
   男人娶不到老婆，原因有三个
   折磨着不少大龄的中年男人

   根据以上提供的选题，帮我重新构思出 50 个公众号类似的爆款选题。
   ```

## 6 步写作框架

1. **标题直接亮观点**：不绕弯子，不靠文采，让用户想点进来验证或反驳。例：《普通人有多少存款，才敢真正失业》《越来越多年轻人不买车，不是因为穷》《37 岁男人存款多少算正常》《钱，难挣到什么程度了》
2. **开头两三句话扔「扎心结论」**：不要上来就铺垫宏大背景，让读者第一眼觉得"这件事真的就发生在我身边"。
3. **用具体故事立住情绪**：不要干巴巴地分析收入结构或讲大道理，直接上具象人物与场景。例：一个 30 多岁的上班族，卡里有 20 万，看着不少；但孩子要上学、父母身体不好、每个月还有房贷，连辞职空窗两个月都不敢。
4. **把核心观点拆成 2~3 个小点**：每一段只说一件事，别一大坨文字堆到底。例：钱为什么让人焦虑？/ 婚姻为什么让人妥协？/ 工作为什么让人不敢停？每个小点都留一点情绪，让读者边看边想"确实，我身边就是这样"。
5. **避坑与误区**：
   - 不要为了制造冲突而故意编造极端案例
   - 不要篇篇都写成「男女对立」
   - 可以让评论区热闹，但内容不能恶意制造矛盾冲突。要让用户觉得"你说得狠，说得还真是那么回事"
   - 抄需求，不抄答案：别看到同行标题爆了就换几个词反复发同一个选题，长期会导致账号模板化、被「低质限流」
6. **结尾总结 + 留一个问题钩子**：简单收尾，抛一个低门槛、有代入感的问题。例："你身边有没有这样的人？""你觉得一个家庭存多少钱，才算真正有安全感？"

## 配图风格

一篇文章的封面和插图要像同一个人画的：同一个 IP 主角、同一套画风、同一个背景色。

### IP 形象

账号所有配图都由同一个 IP 出演，用表情和动作把标题里的处境演出来。读者记住了这个形象，也就记住了账号。

**先看用户选过没有**：桌面端会把用户的 IP 库放在工作区的 `ip/library.json`，用户在设置 →「IP 形象」里管理它：

```json
{
  "defaultId": "…",
  "characters": [
    {
      "id": "…",
      "name": "…",
      "description": "…",
      "prompt": "…",
      "image": "ip/….png"
    }
  ]
}
```

- 有 `defaultId`：直接用这个 IP，它的 `prompt` 就是模板里的 `Character` 一行；回复里告诉用户本篇用的是哪个 IP
- 库里有 IP 但没有默认：列出名字和描述让用户挑一个，或者出新的候选
- 库是空的、没有 `ip/` 目录，或者用户要换新形象：出候选让用户选

**出候选让用户选**：

1. 设计 3 个候选，物种或造型拉开差距（比如一只动物、一个人、一个拟人的物件），都符合下面的画风
2. 每个候选写三样：名字、一句中文描述、英文 `Character` 描述。描述要细到每次都能画成同一个样子：体型和几头身、毛色或肤色、一个记得住的特征、一件固定的衣服
3. 每个候选出一张示例图：`Scene` 写 `standing and facing the viewer, relaxed neutral pose`，米色背景，1:1
4. 把名字、描述和示例图发给用户，**停下来等用户选**，选定之前不画文章配图
5. 用户选定后，在工作区写 `ip/selected.json`，app 会把它存进 IP 库并设为默认，以后的新文章直接沿用：

   ```json
   {
     "name": "阿土",
     "description": "穿砖红卫衣、总也睡不醒的中华田园犬",
     "prompt": "a chubby anthropomorphic Chinese rural dog ...",
     "image": "images/ip-candidate-1.png"
   }
   ```

   用户要换回库里已有的 IP，写 `{ "id": "<库里的 id>" }`。没有 `ip/` 目录时不写文件，这次对话里一直沿用选定的 `Character` 描述

一个合格的 IP 描述，以阿土为例：

- **中文**：直立行走的中华田园犬，胖乎乎的梨形身材，约 2.5 头身；奶白色的毛，左眼一圈圆形棕斑；三角耳，耳尖往下折；黑豆眼，上眼皮总耷拉着，像永远没睡醒；卷尾巴；永远穿同一件洗旧的砖红色卫衣
- **Character**：`a chubby anthropomorphic Chinese rural dog standing upright on short legs, about 2.5 heads tall, pear-shaped body, cream-white fur with a round brown patch around the left eye, short triangular ears with folded tips, small black dot eyes under heavy droopy eyelids, tiny mouth, short curled tail, wearing a faded brick-red hoodie.`

IP 怎么演：

- **情绪**：无奈、躺平、累、发呆，带点自嘲和幽默，不苦大仇深
- **配角**：家人、同事、老板需要出场时，用同样画风的简化造型，比 IP 小、颜色淡，不抢戏

### 画风

- **线条**：手绘卡通，深色描边粗且略带抖动，色块平涂，带一点蜡笔或颗粒纸的质感；造型圆钝简化，像绘本或报刊漫画
- **配色**：颜色少而饱和，芥末黄、橘色、草绿、砖红为主
- **背景**：一整块纯色。一篇文章只定一个背景色（芥末黄、米色、浅草绿任选其一），封面和插图共用
- **构图**：IP 居中，占画面大半
- **不放字**：标题在图下方，画面里不出现文字和数字

### 标题怎么变成画面

先找标题里的情绪，再让 IP 在一个日常场景里演出来。文中插图同理，按小标题换场景，IP 和背景色不变。以阿土为例：

| 标题                                 | 画面                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| 《亏掉 20 万太容易了》               | 阿土托着腮坐在桌前，眼睛半睁，一脸认命，桌上一只摔裂的存钱罐 |
| 《家庭存款的十个等级，你到哪一级了》 | 阿土瘫在沙发上，肚皮上搁着手机，旁边一包薯片                 |
| 《钱，难挣到什么程度了》             | 阿土垂着头蹲在马路牙子上，手心里攥着两枚硬币                 |
| 《新型返贫三件套，一件都不沾》       | 阿土挤在一辆塞满家当的小汽车里，耳朵被车顶压弯了             |

规格：封面横版 2.35:1（如 900×383），IP 放中间，转发时裁成 1:1 缩略图也能看清；文中插图统一 4:3。

### 一篇文章的图怎么保持一致

1. 每张图都用下面的模板：`Character`、`Style` 两行原样照抄，一个词都不改；`Background` 整篇用同一个颜色；只改 `Scene` 和 `Composition`
2. 出图时带上参考图：用 `generate_image` 就把 IP 的 `image`（如 `ip/<id>.png`）放进 `reference_images`；封面定稿后，插图再加上封面。其他生图工具支持参考图的，也这样传
3. 一篇文章的图用同一个工具、同一个模型一次出完，中途不换

### 提示词模板

```text
Character: {the IP's prompt, verbatim}
Style: flat hand-drawn cartoon illustration, thick slightly wobbly dark outlines, flat color fills with subtle crayon and grainy paper texture, simple rounded shapes, picture-book editorial cartoon, humorous and relatable mood, a few saturated colors such as mustard yellow, orange, grass green and brick red.
Scene: {what the character is doing, e.g. sitting at a table with its cheek resting on one paw, half-closed resigned eyes, a cracked piggy bank on the table}.
Background: one solid {mustard yellow | beige | light grass green} background.
Composition: {wide 2.35:1 cover, leave room for a square crop | 4:3 inline illustration | 1:1 candidate sample}, the character centered and filling most of the frame. No text, letters, numbers or watermark.
```

描述画风特征即可，不点名具体画师，也不照搬参考图里的角色。

## AI 辅助工作流

1. **构思输入**：确定选题、人群、核心痛点、真实经历和 6 步框架思路
2. **AI 搭架子**：先生成一篇初稿大纲
3. **人工润色**：补充真实细节与具体例子，优化口语化表达，注入「活人感」

## 核心心法

- 你以为你是在写别人，其实用户点进来，看的是**他自己**。
- 文章不用写得多高深，**胜在真实**。找到大家每天都在经历、却一直没人替他们说出来的困扰，内容就成功了一半。
- 选题够近：离普通人的生活没有距离，内容需求就不会差。
