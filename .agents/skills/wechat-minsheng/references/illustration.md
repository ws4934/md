# 配图风格

一篇文章的封面和插图要像同一个人画的：同一个 IP 主角、同一套画风、同一个背景色。

## IP 形象

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
2. 每个候选写三样：名字、一句中文描述、英文 `Character` 描述。描述要细到每次都能画成同一个样子：体型和几头身、毛色或肤色、一个记得住的特征、一件固定的衣服；不写表情，表情留给每张图的 `Scene`
3. 每个候选出一张示例图：`Scene` 写 `standing and facing the viewer, relaxed neutral pose`，米色背景，1:1
4. 把名字、描述和示例图发给用户，**停下来等用户选**，选定之前不画文章配图
5. 用户选定后，在工作区写 `ip/selected.json`，app 会把它存进 IP 库并设为默认，以后的新文章直接沿用：

   ```json
   {
     "name": "阿土",
     "description": "穿砖红卫衣、左眼一圈棕斑的中华田园犬",
     "prompt": "a chubby anthropomorphic Chinese rural dog ...",
     "image": "images/ip-candidate-1.png"
   }
   ```

   用户要换回库里已有的 IP，写 `{ "id": "<库里的 id>" }`。没有 `ip/` 目录时不写文件，这次对话里一直沿用选定的 `Character` 描述

一个合格的 IP 描述，以阿土为例：

- **中文**：直立行走的中华田园犬，胖乎乎的梨形身材，约 2.5 头身；奶白色的毛，左眼一圈圆形棕斑；三角耳，耳尖往下折；黑豆眼；卷尾巴；永远穿同一件洗旧的砖红色卫衣
- **Character**：`a chubby anthropomorphic Chinese rural dog standing upright on short legs, about 2.5 heads tall, pear-shaped body, cream-white fur with a round brown patch around the left eye, short triangular ears with folded tips, small black dot eyes, tiny mouth, short curled tail, wearing a faded brick-red hoodie.`

IP 怎么演：

- **情绪**：表情跟着这张图的那段话走，心疼、算计、嘴硬、偷乐、认命都行，同一篇里别重样；带点自嘲和幽默，不苦大仇深
- **配角**：家人、同事、老板需要出场时，用同样画风的简化造型，比 IP 小、颜色淡，不抢戏

## 画风

- **线条**：手绘卡通，深色描边粗且略带抖动，色块平涂，带一点蜡笔或颗粒纸的质感；造型圆钝简化，像绘本或报刊漫画
- **配色**：颜色少而饱和，芥末黄、橘色、草绿、砖红为主
- **背景**：一整块纯色。一篇文章只定一个背景色，封面和插图共用，跟排版主题搭：清新配浅草绿，暖阳、手账配芥末黄，其余主题配米色
- **构图**：IP 始终是主角。封面居中；插图按梗换景别，特写、全身、俯视都行，同一篇别每张都一样
- **不放字**：标题在图下方，画面里不出现文字和数字

## 标题怎么变成画面

先找这段话里最戳人的那个细节，再给它一个梗，让人看了会心一笑。标题里的比喻别照字面画，拧水龙头、撑伞、抱存钱罐这些第一反应都换掉。找梗有三个办法：

- **夸张**：把一件小事画大
- **反差**：表情和处境反着来
- **用上 IP 自己**：身体、特征、衣服都能拿来演戏

文中插图同理，每一层讲的事换一个梗，IP 和背景色不变。以阿土为例：

| 标题                                 | 画面                                                         | 梗          |
| ------------------------------------ | ------------------------------------------------------------ | ----------- |
| 《亏掉 20 万太容易了》               | 阿土咧嘴笑着冲镜头竖大拇指，身后的钞票长着小翅膀排队飞出窗外 | 反差        |
| 《家庭存款的十个等级，你到哪一级了》 | 阿土站在一架高梯子的最底下一格，仰着脖子看，梯子顶端扎进云里 | 夸张        |
| 《钱，难挣到什么程度了》             | 阿土满头大汗拉着一辆比它大十倍的板车，车上只放着一枚硬币     | 夸张        |
| 《新型返贫三件套，一件都不沾》       | 阿土挤在一辆塞满家当的小汽车里，耳朵被车顶压弯了             | 用上 IP 自己 |

规格：封面横版 2.35:1（如 900×383），IP 放中间，转发时裁成 1:1 缩略图也能看清；文中插图统一 4:3。

## 一篇文章的图怎么保持一致

1. 每张图都用下面的模板：`Character`、`Style` 两行原样照抄，一个词都不改；`Background` 整篇用同一个颜色；只改 `Scene` 和 `Composition`
2. 出图时带上参考图：用 `generate_image` 就把 IP 的 `image`（如 `ip/<id>.png`）放进 `reference_images`；封面定稿后，插图再加上封面。其他生图工具支持参考图的，也这样传
3. 一篇文章的图用同一个工具、同一个模型一次出完，中途不换

## 提示词模板

```text
Character: {the IP's prompt, verbatim}
Style: flat hand-drawn cartoon illustration, thick slightly wobbly dark outlines, flat color fills with subtle crayon and grainy paper texture, simple rounded shapes, picture-book editorial cartoon, humorous and relatable mood, a few saturated colors such as mustard yellow, orange, grass green and brick red.
Scene: {the gag and the character's facial expression, e.g. grinning and giving a thumbs-up to the viewer while banknotes with little wings fly out of the open window behind it in a line}.
Background: one solid {mustard yellow | beige | light grass green} background.
Composition: {wide 2.35:1 cover, the character centered, leave room for a square crop | 4:3 inline illustration, close-up, full-body or high-angle shot, whichever sells the gag | 1:1 candidate sample, the character centered}, the character is the clear focus. No text, letters, numbers or watermark.
```

描述画风特征即可，不点名具体画师，也不照搬参考图里的角色。
