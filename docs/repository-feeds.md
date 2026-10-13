# 三个采集项目接入试验

接收现有项目的**每日 CSV 产物**，不复制爬虫、不重复调用 RIO / 公众号接口。三个上游继续独立运行。

| 上游 | 路径 | 使用的证据 |
|---|---|---|
| `wodewoping-png/news-spider` | `data/articles-YYYY-MM-DD.csv` | 正文、发布时间、媒体、行业路径、完整性标记 |
| `wodewoping-png/wechat-daily-news-csv` | `csv/YYYY-MM-DD.csv` | 公众号、发布时间、clean_text / digest、原文链接 |
| `wodewoping-png/literature-rss-spider` | `output/news_with_abstract_YYYY-MM-DD.csv` | 期刊、标题、DOI、原始发表日期、摘要 |

## 已实现

- 模块 `modules/repo-feeds/` 接入现有 worker。每小时第 17 分钟检查北京时间当天和前两天的日文件，重读窗口用于承接迟到上传与原位更新。不读取周/月汇总。
- 按媒体、公众号原始 ID、期刊分别建立 `external` 信源，保留原文链接和仓库来源，不把三个项目当成三个媒体。
- 使用引擎 `upsertMaterial`：新闻/公众号按规范化 URL 去重，文献有合法 DOI 时按小写 DOI 去重。重复入库不重跑分析；同源内容更新使用引擎修订机制。
- 所有信源初始为 T2，不擅自判定一手来源。站内全文和全文 RSS 默认关闭。已有信源的停用、分级、参与方式不会被同步覆盖。
- 只在新闻上游声明全文且没有摘要策略冲突时填 `bodyText`。文献摘要及未验证的公众号文本填 `excerpt`，保留其材料类型；无文本不凭标题补写。
- 旧文、未知日期沿用引擎的 48 小时归档规则，不用抓取日期伪装发布日期。原字段与日期精度保存在 `raw.repoFeed`。
- 404 日文件记为 missing；某一路三天都没有文件或发生解析/网络错误，任务标为失败并保留明细，不伪报零条成功。其他成功读取的源仍可导入。

## 先预览

从仓库根目录运行（Node.js 24.11+，先 `npm ci`）：

```bash
node --env-file-if-exists=.env modules/repo-feeds/scripts/trial.ts --days 3
```

默认只读取公开 CSV、生成 `.data/repo-feeds-trial/report.json` 与 `preview.html`，不入库、不调模型。预览只含标题、来源、日期、证据长度、去重和归档状态，不复制全文。网络使用引擎原有的安全抓取器；服务器有代理时沿用 `.env.example` 的 `EGRESS_PROXY_URL` 配置。

也可指定本地文件：

```bash
node modules/repo-feeds/scripts/trial.ts \
  --file news=/path/articles-2026-10-12.csv \
  --file wechat=/path/2026-10-11.csv \
  --file literature=/path/news_with_abstract_2026-10-12.csv
```

## 数据库试入库

```bash
node --env-file=.env modules/repo-feeds/scripts/trial.ts --days 3 --apply
```

默认 `isolated`，数据可在后台诊断，不进入公开页面，也不会调用模型。再次执行应为 created=0、revised=0；若上游修正了材料，revised 可以增加。GitHub Actions 的 **Repository feeds trial** 在 PostgreSQL 17 上验证这一过程（使用固定日期的公开样本），无需配置模型密钥。

## 接入常驻采集

部署本分支并在后端 `.env` 设置：

```dotenv
COLLECT_ENABLED=true
REPO_FEEDS_ENABLED=true
REPO_FEEDS_MODE=isolated
```

重启 worker 后开始每小时检查。设置 `REPO_FEEDS_ENABLED=false` 并重启可停止同步，已有资料不删除。

## 进入真正的精选流程

试验保留了当前站点的默认 AI 行业提示词、分类与门槛。能源、电力、材料等内容可能被预筛挡住，因此**接入成功不代表行业精选已校准**。需要先确定领域范围并调整 `industry/`，配置模型与预算，然后在后台将需要的信源改为 `editorial`。已有隔离信源应通过后台修改参与方式；`REPO_FEEDS_MODE=editorial` 只影响以后新创建的信源，不覆盖管理员设置。

首次就在独立试验数据库走正常模型流程时，可用 `--apply --mode editorial` 创建信源；worker 必须有可用模型凭据并开启 `MODEL_CALLS_ENABLED`。这会按正常流程计费。日报与事件页仍由引擎生成，本模块不写入评分或伪造精选结果。

## 2026-10-13 首次样本结果

| 项目 | CSV 行数 | 独立来源 | 上游全文标记（且无摘要策略冲突） | 摘要 | 未验证文本 | 无文本 |
|---|---:|---:|---:|---:|---:|---:|
| news-spider（10月12日日文件） | 98 | 15 | 96 | 0 | 2 | 0 |
| wechat-daily-news-csv（10月11日日文件） | 367 | 99 | 0 | 0 | 363 | 4 |
| literature-rss-spider（10月12日日文件） | 254 | 29 | 0 | 237 | 0 | 17 |

共 719 条、143 个来源，字段映射未拒绝任何行；该三文件样本内 URL/DOI 去重后仍为 719 条。这里只测材料接入，未评估模型精选准确率。新闻源里 2 条 `public_rss_summary` 与 `content_status=full` 冲突，接入按摘要处理。文献的原始发表日期有早于导出日期的情况，按引擎规则归档，不能强行放到当日热点里。
