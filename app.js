(function () {
  "use strict";

  var DATA = window.MOD_PANEL_DATA;
  if (!DATA) {
    document.body.innerHTML = "<main style='padding:40px;color:white'>面板数据未生成，请先运行数据构建脚本。</main>";
    return;
  }

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };
  var resultGrid = $("#resultGrid");
  var detailDialog = $("#detailDialog");
  var detailContent = $("#detailContent");
  var pagination = $("#pagination");
  var selected = new Set();
  var activeRecord = null;
  var lastFocused = null;
  var toastTimer = null;
  var pageSize = 24;

  var stored = {};
  try {
    stored = JSON.parse(localStorage.getItem("mod-panel-state") || "{}");
  } catch (error) {
    stored = {};
  }

  var state = {
    view: ["resources", "candidates", "other-mod", "box", "bilibili", "dlc", "monitor", "link-workbench"].includes(stored.view) ? stored.view : "resources",
    author: stored.author || "all",
    search: stored.search || "",
    source: stored.source || "all",
    link: stored.link || "all",
    confidence: stored.confidence || "all",
    sort: stored.sort || "default",
    layout: stored.layout === "list" ? "list" : "grid",
    page: 1
  };

  var viewConfig = {
    resources: {
      title: "资源总表",
      context: "PRIMARY RESOURCE INDEX",
      hint: DATA.stats.resources + " 条主资源，其中 " + DATA.stats.primaryWithAnyLink + " 条有明文地址（" + DATA.stats.primaryWithStagedLink + " 条为本次待核补链）；" + DATA.stats.primaryWithoutLink + " 条仍缺地址。明文不等于文件可用。",
      items: DATA.resources
    },
    candidates: {
      title: "新发现 MOD",
      context: "BILIBILI DISCOVERY QUEUE",
      hint: "18 条原有 B 站发现、16 条银手 Johnny 目录候选和 3 条历史整合包；逐链接显示核验层级。明文链接不代表网盘文件可用，文件列表非空也不代表已下载或测试。",
      items: DATA.candidateResources
    },
    "other-mod": {
      title: "其他 MOD · 网盘线索",
      context: "WATCHED AUTHORS · SHARE ENTRANCES",
      hint: DATA.stats.otherModLinks + " 条按作者和分享 ID 去重的网盘入口，含原有资源重复关联；" + DATA.stats.otherModTitleSignals + " 条来源标题含 MOD 等词，" + DATA.stats.otherModWithVideoCover + " 条有关联视频封面。标题和封面不等于网盘内文件名或独立 MOD，公开顶层非空也不证明文件完整。",
      items: DATA.otherModLinks || []
    },
    box: {
      title: "流川盒子作品",
      context: "NEWBEEBOX PUBLIC RECORDS",
      hint: "公开页面的完整介绍、版本信息与多图素材。",
      items: DATA.boxRecords
    },
    bilibili: {
      title: "B站投稿审计",
      context: "BILIBILI AUDIT LIBRARY",
      hint: "646 条公开投稿独立分页；MOD 候选仅为标题关键词标记。",
      items: DATA.biliVideos
    },
    dlc: {
      title: "非线性列车 · DLC 来源目录",
      context: "WEBSITE × BILIBILI CANDIDATE MAP",
      hint: DATA.stats.dlcCatalog + " 篇官网游戏条目；其中 " + DATA.stats.dlcCloudCollections + " 个夸克厂商合集已读公开目录，对应 " + DATA.stats.dlcCloudGames + " 个游戏文件夹和 " + DATA.stats.dlcClaimItems + " 项官网自述内容。清单仅供参考，不代表归档内实际 DLC 或授权。",
      items: DATA.dlcCatalog
    },
    monitor: {
      title: "关注与监控",
      context: "SOURCE WATCH",
      hint: "作者、DLC 方向与待审变化的当前快照。",
      items: []
    },
    "link-workbench": {
      title: "DLC 补链筛选",
      context: "LINK REVIEW WORKBENCH",
      hint: "先给出来源与标题匹配建议，再核验分享；不自动改动官网文章或资源库。",
      items: []
    }
  };

  var workbenchSearch = "";
  var workbenchStatus = "route";
  var batchInputValue = "";
  var batchMatches = [];
  var replacementSource = "";
  var replacementMap = "";
  var replacementPreview = null;

  var confidenceLabels = {
    high: "高置信",
    medium: "中置信",
    low: "低置信",
    unmatched: "未匹配",
    not_applicable: "不适用"
  };

  var roleLabels = {
    mod_package: "MOD 包",
    game_files: "游戏本体",
    patch: "补丁",
    dlc_collection: "多游戏 DLC 来源合集（待核）",
    addon: "附加包",
    standard: "标准版",
    h_version: "H 版",
    resource_link: "资源链接"
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalize(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function sanitizeFilename(value) {
    return String(value || "image")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function saveState() {
    try {
      localStorage.setItem("mod-panel-state", JSON.stringify({
        view: state.view,
        author: state.author,
        search: state.search,
        source: state.source,
        link: state.link,
        confidence: state.confidence,
        sort: state.sort,
        layout: state.layout
      }));
    } catch (error) {
      /* Local preferences are optional. */
    }
  }

  function currentItems() {
    return viewConfig[state.view].items;
  }

  function recordById(id) {
    return currentItems().find(function (item) { return item.id === id; }) ||
      DATA.resources.concat(DATA.candidateResources, DATA.otherModLinks || [], DATA.boxRecords, DATA.biliVideos, DATA.dlcCatalog).find(function (item) { return item.id === id; });
  }

  function showToast(message) {
    var toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2400);
  }

  async function copyText(text, label) {
    if (!text) {
      showToast("该记录没有可复制的" + label);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制" + label);
    } catch (error) {
      $("#fallbackText").value = text;
      $("#copyFallback").hidden = false;
      $("#fallbackText").focus();
      $("#fallbackText").select();
    }
  }

  function shareText(record) {
    var lines = [];
    lines.push("标题：" + record.title);
    if (record.author) lines.push("作者：" + record.author);
    if (record.sourceType) lines.push("来源：" + record.sourceType);
    if (record.status) lines.push("状态：" + record.status);
    if (record.description) {
      lines.push("");
      lines.push("内容：");
      lines.push(record.description);
    }
    if (record.videoTitle) lines.push("对应视频标题：" + record.videoTitle);
    if (record.links && record.links.length) {
      lines.push("");
      lines.push("网盘链接：");
      record.links.forEach(function (link, index) {
        lines.push((index + 1) + ". " + (roleLabels[link.role] || link.role || "资源") + "｜" + link.provider + (link.status ? "｜" + link.status : ""));
        lines.push(link.url);
        if (link.code) lines.push("提取码：" + link.code);
        if (link.checkedAt) lines.push("核验时间：" + link.checkedAt);
      });
    }
    if (record.biliLinks && record.biliLinks.length) {
      lines.push("");
      lines.push("B站：");
      record.biliLinks.forEach(function (link) { lines.push(link.url); });
    }
    if (record.sourceUrl) {
      lines.push("");
      lines.push("来源页面：" + record.sourceUrl);
    }
    return lines.join("\n");
  }

  function linksText(record) {
    var links = (record.links || []).filter(function (link) {
      return link.provider === "夸克" && (!link.liveStatus || link.liveStatus === "live_confirmed");
    });
    if (!links.length) return "";
    var blocks = links.map(function (link, index) {
      var lines = [
        "标题：" + record.title,
        "类型：" + (roleLabels[link.role] || link.role || "资源"),
        "夸克：" + link.url
      ];
      if (link.code) lines.push("提取码：" + link.code);
      if (links.length > 1) lines.unshift("链接 " + (index + 1));
      return lines.join("\n");
    });
    return blocks.join("\n\n");
  }

  async function downloadImage(url, title) {
    if (!url) {
      showToast("该记录没有可下载的图片");
      return;
    }
    var safeUrl = url;
    var extension = "jpg";
    try {
      var parsed = new URL(url, window.location.href);
      var match = parsed.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
      if (match) extension = match[1].toLowerCase().replace("jpeg", "jpg");
    } catch (error) {
      /* Keep the default extension. */
    }
    try {
      var response = await fetch(safeUrl);
      if (!response.ok) throw new Error("HTTP " + response.status);
      var blob = await response.blob();
      var mimeExt = {
        "image/png": "png",
        "image/webp": "webp",
        "image/jpeg": "jpg",
        "image/gif": "gif"
      }[blob.type];
      if (mimeExt) extension = mimeExt;
      var objectUrl = URL.createObjectURL(blob);
      var anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = sanitizeFilename(title) + "." + extension;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1200);
      showToast("图片下载已开始");
    } catch (error) {
      window.open(safeUrl, "_blank", "noopener");
      showToast("浏览器阻止直接下载，已打开原图");
    }
  }

  function sourceOptions(items) {
    var select = $("#sourceFilter");
    var old = state.source;
    var options;
    if (state.view === "bilibili") {
      options = [
        { value: "all", label: "全部投稿" },
        { value: "candidate", label: "MOD 候选" },
        { value: "non-candidate", label: "非 MOD 候选" }
      ];
    } else {
      var values = Array.from(new Set(items.map(function (item) { return item.sourceType; }).filter(Boolean)));
      options = [{ value: "all", label: "全部来源" }].concat(values.map(function (value) {
        return { value: value, label: value };
      }));
    }
    select.innerHTML = options.map(function (option) {
      return "<option value='" + escapeHtml(option.value) + "'>" + escapeHtml(option.label) + "</option>";
    }).join("");
    if (options.some(function (option) { return option.value === old; })) select.value = old;
    else {
      state.source = "all";
      select.value = "all";
    }
  }

  function contextualFilterOptions() {
    var other = state.view === "other-mod";
    $("#linkFilterLabel").textContent = other ? "网盘 / 核验" : "网盘";
    $("#confidenceFilterLabel").textContent = other ? "标题 / 封面" : "匹配";
    var linkOptions = other ? [
      ["all", "全部网盘"], ["quark", "夸克"], ["baidu", "百度"],
      ["thunder", "迅雷"], ["other-provider", "其他网盘"],
      ["root-nonempty", "公开顶层非空"], ["needs-review", "未核或异常"]
    ] : [
      ["all", "全部状态"], ["quark", "有夸克"], ["no-quark", "无夸克"],
      ["inactive", "过期 / 失效 / 施工中"]
    ];
    var titleOptions = other ? [
      ["all", "全部线索"], ["signal", "标题含 MOD"],
      ["no-signal", "标题待判"], ["with-cover", "有关联视频封面"],
      ["without-cover", "尚无封面"], ["curated", "已在原有资源"]
    ] : [
      ["all", "全部置信度"], ["high", "高置信"],
      ["medium", "中置信"], ["low", "低置信"], ["unmatched", "未匹配"]
    ];
    $("#linkFilter").innerHTML = linkOptions.map(function (option) {
      return "<option value='" + option[0] + "'>" + option[1] + "</option>";
    }).join("");
    $("#confidenceFilter").innerHTML = titleOptions.map(function (option) {
      return "<option value='" + option[0] + "'>" + option[1] + "</option>";
    }).join("");
    if (!linkOptions.some(function (option) { return option[0] === state.link; })) state.link = "all";
    if (!titleOptions.some(function (option) { return option[0] === state.confidence; })) state.confidence = "all";
  }

  function renderAuthorButtons(items) {
    var counts = new Map();
    items.forEach(function (item) {
      counts.set(item.author, (counts.get(item.author) || 0) + 1);
    });
    var authors = Array.from(counts.keys());
    if (state.author !== "all" && !counts.has(state.author)) state.author = "all";
    var html = "<button type='button' class='author-button " + (state.author === "all" ? "active" : "") + "' data-author='all'><span>全部作者</span><span>" + items.length + "</span></button>";
    html += authors.map(function (author) {
      return "<button type='button' class='author-button " + (state.author === author ? "active" : "") + "' data-author='" + escapeHtml(author) + "'><span>" + escapeHtml(author) + "</span><span>" + counts.get(author) + "</span></button>";
    }).join("");
    $("#authorButtons").innerHTML = html;
  }

  function filterItems() {
    var query = normalize(state.search);
    var items = currentItems().filter(function (item) {
      if (state.author !== "all" && item.author !== state.author) return false;
      if (state.view === "other-mod") {
        if (state.source !== "all" && item.sourceType !== state.source) return false;
        var provider = item.links[0].provider;
        if (state.link === "quark" && provider !== "夸克") return false;
        if (state.link === "baidu" && provider !== "百度") return false;
        if (state.link === "thunder" && provider !== "迅雷") return false;
        if (state.link === "other-provider" && ["夸克", "百度", "迅雷"].includes(provider)) return false;
        if (state.link === "root-nonempty" && item.checkStatus !== "root_nonempty") return false;
        if (state.link === "needs-review" && item.checkStatus === "root_nonempty") return false;
        if (state.confidence === "signal" && !item.modTitleSignal) return false;
        if (state.confidence === "no-signal" && item.modTitleSignal) return false;
        if (state.confidence === "with-cover" && !(item.cover || item.coverOriginal)) return false;
        if (state.confidence === "without-cover" && (item.cover || item.coverOriginal)) return false;
        if (state.confidence === "curated" && !item.hasCuratedItem) return false;
      } else if (state.view === "bilibili") {
        if (state.source === "candidate" && !item.isModCandidate) return false;
        if (state.source === "non-candidate" && item.isModCandidate) return false;
      } else {
        if (state.source !== "all" && item.sourceType !== state.source) return false;
        if (state.view !== "dlc") {
          var quark = (item.links || []).some(function (link) { return link.provider === "夸克"; });
          if (state.link === "quark" && !quark) return false;
          if (state.link === "no-quark" && quark) return false;
          if (state.link === "inactive" && !/(过期|失效|施工中|仅迅雷|仅百度|缺少)/.test(item.status || "")) return false;
          if (state.confidence !== "all" && item.confidence !== state.confidence) return false;
        }
      }
      if (!query) return true;
      var haystack = [
        item.title,
        item.originalTitle,
        item.videoTitle,
        item.game,
        item.category,
        item.summary,
        item.description,
        item.bvid,
        item.author,
        item.status,
        (item.links || []).map(function (link) { return link.url + " " + link.provider; }).join(" "),
        (item.biliLinks || []).map(function (link) { return link.title; }).join(" "),
        item.dlcEvidence ? item.dlcEvidence.claimedNames.map(function (claim) { return claim.original + " " + claim.chinese; }).join(" ") : "",
        (item.keywordHits || []).join(" "),
        JSON.stringify(item.metadata || {})
      ].map(normalize).join(" ");
      return haystack.includes(query);
    });

    items.sort(function (a, b) {
      if (state.view === "other-mod" && state.sort === "default") return Number(b.modTitleSignal) - Number(a.modTitleSignal) || Number(a.order) - Number(b.order);
      if (state.view === "dlc" && state.sort === "default" && Boolean(a.dlcEvidence) !== Boolean(b.dlcEvidence)) return a.dlcEvidence ? -1 : 1;
      if (state.sort === "title") return String(a.title).localeCompare(String(b.title), "zh-CN");
      if (state.sort === "newest") return String(b.publishedAt || b.updatedAt || "").localeCompare(String(a.publishedAt || a.updatedAt || ""));
      if (state.sort === "author") return String(a.author).localeCompare(String(b.author), "zh-CN") || Number(a.order || 0) - Number(b.order || 0);
      return 0;
    });
    return items;
  }

  function coverMarkup(item) {
    var src = item.cover || item.coverOriginal;
    if (!src) {
      return "<div class='cover-placeholder'><div><span>NO IMG</span><small>封面未匹配</small></div></div>";
    }
    return "<img loading='lazy' src='" + escapeHtml(src) + "' alt='" + escapeHtml(item.title) + " 封面' onerror='this.hidden=true;this.nextElementSibling.hidden=false'><div class='cover-placeholder' hidden><div><span>NO IMG</span><small>图片加载失败</small></div></div>";
  }

  function confidenceBadge(item) {
    if (!item.confidence) return "";
    var label = confidenceLabels[item.confidence] || item.confidence;
    return "<span class='badge " + escapeHtml(item.confidence) + "'>" + escapeHtml(label) + "</span>";
  }

  function resourceCard(item) {
    var confirmedQuark = (item.links || []).filter(function (link) {
      return link.provider === "夸克" && (!link.liveStatus || link.liveStatus === "live_confirmed");
    });
    var hasQuark = confirmedQuark.length > 0;
    var summary = item.summary || item.description || item.videoTitle || item.matchNote || "该来源没有采集到介绍";
    var warning = /(过期|失效|施工中|仅迅雷|仅百度|缺少|待补|文件未核)/.test(item.status || "");
    return "<article class='resource-card' data-id='" + escapeHtml(item.id) + "'>" +
      "<div class='card-cover'>" +
        coverMarkup(item) +
        "<span class='source-chip'>" + escapeHtml(item.sourceType) + "</span>" +
        "<label class='select-box' aria-label='选择 " + escapeHtml(item.title) + "'><input type='checkbox' data-select='" + escapeHtml(item.id) + "'" + (selected.has(item.id) ? " checked" : "") + "></label>" +
      "</div>" +
      "<div class='card-body'>" +
        "<div class='card-meta-line'><b>" + escapeHtml(item.author) + "</b><span>" + escapeHtml(item.game || item.category || "资源") + "</span></div>" +
        "<h3 class='card-title' title='" + escapeHtml(item.title) + "'>" + escapeHtml(item.title) + "</h3>" +
        "<p class='card-summary'>" + escapeHtml(summary) + "</p>" +
        "<div class='badge-row'>" +
          (hasQuark ? "<span class='badge quark'>" + (item.sourceType === "B站新发现" ? "文件列表已核夸克" : "夸克地址") + " × " + confirmedQuark.length + "</span>" : "<span class='badge'>无已核夸克</span>") +
          (item.stagedLinkCount ? "<span class='badge warning'>" + (item.sourceType === "B站历史整合包" ? "简介明文待核" : "文档补链待核") + " × " + item.stagedLinkCount + "</span>" : "") +
          confidenceBadge(item) +
          "<span class='badge " + (warning ? "warning" : "") + "'>" + escapeHtml(item.status || "未采集状态") + "</span>" +
        "</div>" +
        "<div class='card-actions'>" +
          "<button type='button' data-action='copy-title'>复制标题</button>" +
          "<button type='button' data-action='copy-content'" + (!item.description ? " disabled title='该来源未采集到介绍'" : "") + ">复制内容</button>" +
          "<button type='button' data-action='copy-links'" + (!hasQuark ? " disabled" : "") + ">复制夸克</button>" +
          "<button type='button' data-action='download-cover'" + (!(item.coverOriginal || item.cover) ? " disabled" : "") + ">下载图片</button>" +
          "<button type='button' class='primary' data-action='details'>查看详情</button>" +
        "</div>" +
      "</div>" +
    "</article>";
  }

  function otherModCard(item) {
    var link = item.links[0];
    var hasCover = Boolean(item.cover || item.coverOriginal);
    var statusClass = item.checkStatus === "root_nonempty" ? "quark" : "warning";
    return "<article class='resource-card other-mod-card' data-id='" + escapeHtml(item.id) + "'>" +
      "<div class='card-cover'>" + coverMarkup(item) +
        "<span class='source-chip'>网盘入口 · 待核</span></div>" +
      "<div class='card-body'>" +
        "<div class='card-meta-line'><b>" + escapeHtml(item.author) + "</b><span>" + escapeHtml(link.provider) + "</span></div>" +
        "<h3 class='card-title' title='" + escapeHtml(item.title) + "'>" + escapeHtml(item.title) + "</h3>" +
        "<p class='card-summary'>" + escapeHtml(item.summary) + "</p>" +
        "<div class='badge-row'>" +
          "<span class='badge " + statusClass + "'>" + escapeHtml(item.status) + "</span>" +
          "<span class='badge " + (item.modTitleSignal ? "medium" : "warning") + "'>" + (item.modTitleSignal ? "标题含 MOD · 内容待核" : "标题待判") + "</span>" +
          (item.hasCuratedItem ? "<span class='badge'>原有资源已收录</span>" : "") +
          (hasCover ? "<span class='badge'>关联视频封面</span>" : "<span class='badge'>暂无封面</span>") +
        "</div>" +
        "<div class='card-actions'>" +
          "<button type='button' data-action='copy-title'>复制来源标题</button>" +
          "<button type='button' data-action='copy-share'>复制网盘链接</button>" +
          "<button type='button' data-action='download-cover'" + (hasCover ? "" : " disabled") + ">下载视频封面</button>" +
          "<button type='button' class='primary' data-action='details'>查看来源与核验</button>" +
        "</div>" +
      "</div></article>";
  }

  function biliCard(item) {
    return "<article class='resource-card bili-card' data-id='" + escapeHtml(item.id) + "'>" +
      "<div class='card-cover'>" +
        coverMarkup(item) +
        "<span class='source-chip'>" + (item.isModCandidate ? "MOD 候选" : "投稿审计") + "</span>" +
        "<label class='select-box' aria-label='选择 " + escapeHtml(item.title) + "'><input type='checkbox' data-select='" + escapeHtml(item.id) + "'" + (selected.has(item.id) ? " checked" : "") + "></label>" +
      "</div>" +
      "<div class='card-body'>" +
        "<div class='card-meta-line'><b>" + escapeHtml(item.author) + "</b><span>" + escapeHtml((item.publishedAt || "").slice(0, 10) || "时间未采集") + "</span></div>" +
        "<h3 class='card-title' title='" + escapeHtml(item.title) + "'>" + escapeHtml(item.title) + "</h3>" +
        "<p class='card-summary'>" + escapeHtml(item.bvid) + "</p>" +
        "<div class='badge-row'>" +
          "<span class='badge " + (item.isModCandidate ? "quark" : "") + "'>" + (item.isModCandidate ? "标题命中 MOD" : "非 MOD 候选") + "</span>" +
          (item.keywordHits || []).slice(0, 2).map(function (hit) { return "<span class='badge'>" + escapeHtml(hit) + "</span>"; }).join("") +
        "</div>" +
        "<div class='card-actions'>" +
          "<button type='button' data-action='copy-title'>复制标题</button>" +
          "<button type='button' data-action='download-cover'>下载图片</button>" +
          "<button type='button' class='primary' data-action='open-bili'>打开 B站</button>" +
          "<button type='button' data-action='details'>查看详情</button>" +
        "</div>" +
      "</div>" +
    "</article>";
  }

  function dlcCard(item) {
    return "<article class='resource-card' data-id='" + escapeHtml(item.id) + "'>" +
      "<div class='card-cover'>" + coverMarkup(item) + "<span class='source-chip'>官网 × B站候选</span></div>" +
      "<div class='card-body'>" +
        "<div class='card-meta-line'><b>非线性列车</b><span>官网目录</span></div>" +
        "<h3 class='card-title' title='" + escapeHtml(item.title) + "'>" + escapeHtml(item.title) + "</h3>" +
        "<p class='card-summary'>" + escapeHtml(item.summary || "官网摘要未提供") + "</p>" +
        "<div class='badge-row'>" +
          (item.dlcEvidence ? "<span class='badge quark'>夸克厂商合集 · 已读目录</span><span class='badge'>官网清单 " + item.dlcEvidence.claimedNames.length + " 项</span>" : "<span class='badge'>尚未定位最终网盘</span>") +
          "<span class='badge'>专栏候选 " + item.articleMatchCount + "</span><span class='badge'>视频候选 " + item.videoMatchCount + "</span>" +
        "</div>" +
        "<div class='card-actions'><button type='button' data-action='copy-title'>复制标题</button><button type='button' data-action='download-cover'>下载图片</button><button type='button' class='primary' data-action='details'>查看对应来源</button></div>" +
      "</div></article>";
  }

  function renderPagination(total) {
    if (!["bilibili", "dlc", "other-mod"].includes(state.view) || total <= pageSize) {
      pagination.hidden = true;
      pagination.innerHTML = "";
      return;
    }
    var pages = Math.ceil(total / pageSize);
    state.page = Math.min(Math.max(1, state.page), pages);
    var start = Math.max(1, state.page - 2);
    var end = Math.min(pages, start + 4);
    start = Math.max(1, end - 4);
    var html = "<button type='button' data-page='" + Math.max(1, state.page - 1) + "' aria-label='上一页'>←</button>";
    if (start > 1) html += "<button type='button' data-page='1'>1</button><span class='badge'>…</span>";
    for (var page = start; page <= end; page += 1) {
      html += "<button type='button' class='" + (page === state.page ? "active" : "") + "' data-page='" + page + "'>" + page + "</button>";
    }
    if (end < pages) html += "<span class='badge'>…</span><button type='button' data-page='" + pages + "'>" + pages + "</button>";
    html += "<button type='button' data-page='" + Math.min(pages, state.page + 1) + "' aria-label='下一页'>→</button>";
    pagination.innerHTML = html;
    pagination.hidden = false;
  }

  function renderMonitor() {
    var authors = DATA.watchAuthors || [];
    var events = (DATA.watchEvents || []).slice().reverse();
    var pendingEvents = events.filter(function (event) { return event.review_status !== "非MOD排除"; }).length;
    var lastRun = DATA.watchLastRunAt ? new Date(DATA.watchLastRunAt).toLocaleString("zh-CN") : "尚未执行";
    var success = authors.filter(function (author) { return author.lastSuccessAt && !author.lastError; }).length;
    var cards = authors.map(function (author) {
      var newest = author.latestVideos && author.latestVideos[0];
      var status = author.lastError ? "本次检查失败：" + author.lastError : author.lastSuccessAt ? "最近成功：" + new Date(author.lastSuccessAt).toLocaleString("zh-CN") : "尚未成功检查";
      return "<article class='watch-card'>" +
        "<div class='watch-card-head'><div><small>" + escapeHtml(author.group) + " · UID " + escapeHtml(author.mid) + "</small><h3>" + escapeHtml(author.name) + "</h3></div><span class='badge " + (author.lastError ? "warning" : "high") + "'>" + (author.lastError ? "暂不可核" : "已建基线") + "</span></div>" +
        "<p>" + escapeHtml(status) + "</p>" +
        "<p>面板内待审候选 " + author.knownCandidates + " 条" + (author.archivedVideos ? " · 旧库投稿 " + author.archivedVideos + " 条" : "") + "</p>" +
        "<p>简介取链：完整简介 " + author.descriptionsRead + " / 已知 " + author.knownVideos + " 条" + (author.descriptionsPreviewOnly ? "；仅有前 255 字预览 " + author.descriptionsPreviewOnly + " 条" : "") + "；" + author.videosWithCloudUrl + " 条简介见网盘 URL（来源明文，未核文件）</p>" +
        (author.historyCoverage !== "list_count_reached" ? "<p>历史投稿尚未全量覆盖</p>" : "") +
        "<p>取链路径：" + escapeHtml(author.linkRoute) + "</p>" +
        "<p>链接状态：" + escapeHtml(author.linkStatus) + "</p>" +
        (newest ? "<p class='watch-latest'>列表最新：" + escapeHtml(newest.title) + "</p>" : "") +
        "<div class='watch-card-actions'><a href='" + escapeHtml(author.url) + "' target='_blank' rel='noopener'>作者主页</a><a href='" + escapeHtml(author.listUrl) + "' target='_blank' rel='noopener'>投稿列表</a>" + (author.linkRouteUrl ? "<a href='" + escapeHtml(author.linkRouteUrl) + "' target='_blank' rel='noopener'>取链入口</a>" : "") + "</div>" +
      "</article>";
    }).join("");
    var eventMarkup = events.length ? events.slice(0, 12).map(function (event) {
      var label = event.review_status || "待审";
      var cloudLinks = (event.linkRoutes || []).filter(function (route) { return route.kind === "cloud"; });
      var linkNote = event.descriptionStatus === "read" ?
        (cloudLinks.length ? "简介提取 " + cloudLinks.length + " 个网盘 URL；待确认是否属于 MOD，地址保存在本地取链台账" : "简介未见网盘直链；仍需查作者文档或回复") :
        "简介尚未读取";
      return "<article class='watch-event'><span class='badge " + (label === "非MOD排除" ? "" : "warning") + "'>" + escapeHtml(label) + "</span><div><strong>" + escapeHtml(event.author) + "</strong><p>" + escapeHtml(event.title) + "</p><p>" + linkNote + "</p>" + (event.review_note ? "<p>" + escapeHtml(event.review_note) + "</p>" : "") + "</div><a href='" + escapeHtml(event.url) + "' target='_blank' rel='noopener'>打开视频</a></article>";
    }).join("") : "<p class='monitor-note'>目前没有巡检后新增的待审视频。首次巡检只建立基线，不代表历史没有可收录资源。</p>";
    var dlcMarkup = (DATA.dlcTargets || []).map(function (game) {
      return "<a class='dlc-target' href='" + escapeHtml(game.url) + "' target='_blank' rel='noopener'><span>" + escapeHtml(game.name) + "</span><small>官方 DLC 目录 ↗</small></a>";
    }).join("");
    $("#monitorPanel").innerHTML =
      "<div class='monitor-summary'><div><span class='eyebrow'>LATEST CHECK</span><strong>" + escapeHtml(lastRun) + "</strong><small>静态快照，不是实时在线状态</small></div><div><span class='eyebrow'>BILIBILI SOURCES</span><strong>" + success + " / " + authors.length + "</strong><small>本次成功读取作者列表</small></div><div><span class='eyebrow'>REVIEW QUEUE</span><strong>" + pendingEvents + "</strong><small>本轮新增 " + events.length + " 条，排除 " + (events.length - pendingEvents) + " 条</small></div></div>" +
      "<section class='monitor-section'><div class='monitor-heading'><div><p class='eyebrow'>01 · AUTHORS</p><h2>关注作者</h2></div><p>投稿与公开简介增量巡检；历史覆盖、作者文档及私信另行核对。URL 不等于分享文件可用。列表失败时保留上次成功数据。</p></div><div class='watch-grid'>" + cards + "</div></section>" +
      "<section class='monitor-section'><div class='monitor-heading'><div><p class='eyebrow'>02 · CHANGES</p><h2>新增投稿核对</h2></div><p>逐条区分候选与非 MOD；文件列表可读不等于已下载、已测试或获得转载授权。</p></div><div class='watch-events'>" + eventMarkup + "</div></section>" +
      "<section class='monitor-section'><div class='monitor-heading'><div><p class='eyebrow'>03 · DLC</p><h2>全 DLC 补丁线索</h2></div><p>与 MOD 同一套关注流程；当前尚无已核实可收录的网盘补丁。先按游戏追踪官方目录与版本，第三方文件另行审阅。</p></div><div class='dlc-targets'>" + dlcMarkup + "</div></section>";
  }

  function matchKey(value) {
    return String(value || "").toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/【[^】]*】/g, " ")
      .replace(/[^a-z0-9\u3400-\u9fff]+/g, "").trim();
  }

  function diceScore(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.length < 3 || right.length < 3) return 0;
    var grams = new Map();
    for (var i = 0; i < left.length - 1; i += 1) {
      var gram = left.slice(i, i + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }
    var hits = 0;
    for (var j = 0; j < right.length - 1; j += 1) {
      var other = right.slice(j, j + 2);
      if (grams.get(other)) { hits += 1; grams.set(other, grams.get(other) - 1); }
    }
    return 2 * hits / (left.length + right.length - 2);
  }

  function shareIdentity(url) {
    try {
      var parsed = new URL(url);
      var host = parsed.hostname.toLowerCase();
      var providers = [
        [/^(?:pan\.)?quark\.cn$/, "夸克", /\/s\/([^/?#]+)/],
        [/^pan\.baidu\.com$/, "百度", /\/s\/([^/?#]+)/],
        [/^pan\.xunlei\.com$/, "迅雷", /\/s\/([^/?#]+)/],
        [/^(?:www\.)?aliyundrive\.com$/, "阿里云盘", /\/s\/([^/?#]+)/],
        [/^(?:www\.)?alipan\.com$/, "阿里云盘", /\/s\/([^/?#]+)/],
        [/^(?:www\.)?123pan\.com$/, "123云盘", /\/s\/([^/?#]+)/],
        [/^drive\.google\.com$/, "Google Drive", /\/(?:folders|file\/d)\/([^/?#]+)/]
      ];
      var found = providers.find(function (entry) { return entry[0].test(host); });
      var id = found && parsed.pathname.match(found[2]);
      return id ? { provider: found[1], shareId: id[1], key: found[1] + ":" + id[1] } : null;
    } catch (error) { return null; }
  }

  function suggestBatchLine(line, duplicateCount) {
    var urlMatch = line.match(/https?:\/\/[^\s，,，、|]+/i);
    if (!urlMatch) return { input: line, status: "无链接", note: "每行需要名称、真实网盘分享 URL；仅中转域名不算最终分享。" };
    var url = urlMatch[0].replace(/[)）;；。]+$/, "");
    var share = shareIdentity(url);
    var label = line.slice(0, urlMatch.index).replace(/[|｜\t]+$/, "").trim();
    if (!share) return { input: line, url: url, status: "非已识别网盘", note: "请检查是否仍是官网中转页，不能直接替换。" };
    if (!label) return { input: line, url: url, provider: share.provider, shareId: share.shareId, status: "缺名称", note: "仅凭分享 ID 无法对应文章或文件。" };
    var bytesMatch = label.match(/(?:bytes?|size|大小)\s*[:=：]\s*(\d{3,})|(?:\t|\|)\s*(\d{3,})\s*$/i);
    var bytes = bytesMatch ? Number(bytesMatch[1] || bytesMatch[2]) : 0;
    var cleaned = label.replace(/(?:bytes?|size|大小)\s*[:=：]\s*\d{3,}/ig, "").replace(/(?:\t|\|)\s*\d{3,}\s*$/, "").trim();
    var key = matchKey(cleaned);
    var slashParts = cleaned.split(/[\\/]/).filter(Boolean);
    var fileKey = matchKey(slashParts[slashParts.length - 1] || cleaned);
    var parentKey = slashParts.length > 1 ? matchKey(slashParts.slice(0, -1).join(" ")) : "";
    var records = DATA.dlcCatalog;
    var files = records.flatMap(function (record) {
      return (record.dlcEvidence?.files || []).map(function (file) { return { record: record, file: file }; });
    });
    var fileCode = cleaned.match(/jfile-[a-f0-9]{12}/i);
    var direct = fileCode ? files.filter(function (row) { return row.file.sourceFileId === fileCode[0].toLowerCase(); }) : [];
    var exactFile = direct.length ? direct : files.filter(function (row) {
      var gameKey = matchKey(row.record.game);
      var englishGame = matchKey(row.record.game.split(/[\u3400-\u9fff]/)[0]);
      var parentMatches = !parentKey || gameKey.includes(parentKey) || parentKey.includes(gameKey) || (englishGame.length > 3 && parentKey.includes(englishGame));
      return matchKey(row.file.name) === fileKey && (!bytes || row.file.sizeBytes === bytes) && parentMatches;
    });
    var exactGame = records.filter(function (record) { return matchKey(record.game) === key; });
    var chosen = null;
    var status = "未匹配";
    var note = "名称与已采集文章、文件名均未形成可靠对应。";
    if (exactFile.length === 1) {
      chosen = exactFile[0];
      status = direct.length || bytes ? "高置信待核" : "文件名待核";
      note = direct.length ? "逐文件对应码命中；仍需核对分享中的实际文件。" : bytes ? "文件名和字节大小命中；仍需核对原路径。" : "文件名唯一命中；缺少字节大小和原路径。";
    } else if (exactFile.length > 1) {
      status = "同名歧义";
      note = "同名文件命中 " + exactFile.length + " 项；请补充原游戏路径、字节大小或 jfile 对应码。";
    } else if (exactGame.length === 1) {
      chosen = { record: exactGame[0] };
      status = "标题待核";
      note = "游戏标题相同，但未证明分享内含此游戏或对应版本。";
    } else {
      var ranked = records.map(function (record) { return { record: record, score: diceScore(key, matchKey(record.game)) }; })
        .sort(function (a, b) { return b.score - a.score; });
      if (ranked[0]?.score >= 0.82 && ranked[0].score - (ranked[1]?.score || 0) >= 0.12) {
        chosen = ranked[0];
        status = "相似标题待核";
        note = "标题相似度 " + Math.round(ranked[0].score * 100) + "%；需人工检查游戏、平台、版本和网盘目录。";
      } else if (ranked[0]?.score >= 0.65) {
        status = "标题歧义";
        note = "多个文章标题相近，未自动选定。";
      }
    }
    if (chosen?.file && bytes && chosen.file.sizeBytes !== bytes) {
      status = "大小冲突";
      note = "对应码命中，但输入字节大小与原目录不一致；可能是更新包或错误分享，不能替换。";
    }
    if (duplicateCount > 1) note += " 同一分享 ID 出现 " + duplicateCount + " 次，可能是多游戏合集，不自动合并成单游戏链接。";
    return {
      input: line, label: cleaned, bytes: bytes || null, url: url, provider: share.provider, shareId: share.shareId,
      status: status, note: note, articleTitle: chosen?.record.title || "", articleUrl: chosen?.record.sourceUrl || "",
      game: chosen?.record.game || "", sourceFileId: chosen?.file?.sourceFileId || "", sourcePathId: chosen?.file?.sourcePathId || "",
      fileName: chosen?.file?.name || "", reviewStatus: "待人工核验；未替换原链接"
    };
  }

  function runBatchMatch() {
    var lines = batchInputValue.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean).slice(0, 500);
    var counts = new Map();
    lines.forEach(function (line) {
      var match = line.match(/https?:\/\/[^\s，,，、|]+/i);
      var share = match && shareIdentity(match[0].replace(/[)）;；。]+$/, ""));
      if (share) counts.set(share.key, (counts.get(share.key) || 0) + 1);
    });
    batchMatches = lines.map(function (line) {
      var match = line.match(/https?:\/\/[^\s，,，、|]+/i);
      var share = match && shareIdentity(match[0].replace(/[)）;；。]+$/, ""));
      return suggestBatchLine(line, share ? counts.get(share.key) : 0);
    });
    renderWorkbench();
  }

  function prepareReplacement() {
    var rows = replacementMap.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    var mappings = [];
    var errors = [];
    var seen = new Map();
    rows.forEach(function (line, index) {
      var parts = line.split(/\t|\s+=>\s+|\s+\|\s+/).map(function (part) { return part.trim(); });
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        errors.push("第 " + (index + 1) + " 行格式不正确：需要旧链接 | 新链接。");
        return;
      }
      var oldUrl = parts[0];
      var newUrl = parts[1];
      if (!/^(?:https?:\/\/|magnet:\?)/i.test(oldUrl) || !/^https:\/\//i.test(newUrl)) {
        errors.push("第 " + (index + 1) + " 行不是完整旧链接或 HTTPS 新链接。");
        return;
      }
      try { new URL(newUrl); } catch (error) { errors.push("第 " + (index + 1) + " 行新链接无效。"); return; }
      if (oldUrl === newUrl) { errors.push("第 " + (index + 1) + " 行新旧链接相同。"); return; }
      if (seen.has(oldUrl) && seen.get(oldUrl) !== newUrl) { errors.push("第 " + (index + 1) + " 行旧链接被指定了不同的新链接。"); return; }
      if (!seen.has(oldUrl)) { seen.set(oldUrl, newUrl); mappings.push({ oldUrl: oldUrl, newUrl: newUrl }); }
    });
    if (!replacementSource.trim()) errors.push("请先粘贴要处理的文章文本或 HTML。");
    if (!mappings.length) errors.push("请提供至少一组有效的旧链接和新链接。");
    if (errors.length) { replacementPreview = { errors: errors, text: "", audit: [] }; renderWorkbench(); return; }
    var choices = [];
    var audit = mappings.map(function (mapping, index) {
      var htmlOld = mapping.oldUrl.replace(/&/g, "&amp;");
      choices.push({ oldText: mapping.oldUrl, newText: mapping.newUrl, index: index, htmlEscaped: false });
      if (htmlOld !== mapping.oldUrl) choices.push({ oldText: htmlOld, newText: mapping.newUrl.replace(/&/g, "&amp;"), index: index, htmlEscaped: true });
      return { oldUrl: mapping.oldUrl, newUrl: mapping.newUrl, plainCount: 0, htmlEscapedCount: 0, status: "原文未找到，未替换" };
    });
    choices.sort(function (a, b) { return b.oldText.length - a.oldText.length; });
    var expression = new RegExp(choices.map(function (choice) { return choice.oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|"), "g");
    var replacements = new Map(choices.map(function (choice) { return [choice.oldText, choice]; }));
    var output = replacementSource.replace(expression, function (oldText, offset, fullText) {
      if (/[a-z0-9_~/%?&#=+.-]/i.test(fullText.charAt(offset + oldText.length))) return oldText;
      var choice = replacements.get(oldText);
      audit[choice.index][choice.htmlEscaped ? "htmlEscapedCount" : "plainCount"] += 1;
      return choice.newText;
    });
    audit.forEach(function (row) { if (row.plainCount + row.htmlEscapedCount) row.status = "预览已替换"; });
    replacementPreview = { errors: [], text: output, audit: audit };
    renderWorkbench();
  }

  function renderWorkbench() {
    var catalog = DATA.dlcCatalog;
    var filtered = catalog.filter(function (record) {
      if (workbenchStatus === "route" && (!record.routeLinks.length || record.dlcEvidence)) return false;
      if (workbenchStatus === "no-route" && record.routeLinks.length) return false;
      if (workbenchStatus === "cloud" && !record.dlcEvidence) return false;
      return !workbenchSearch || normalize(record.title + " " + record.game).includes(normalize(workbenchSearch));
    });
    var cards = filtered.slice(0, 36).map(function (record) {
      return "<article class='link-review-row'><div><strong>" + escapeHtml(record.game) + "</strong><small>" +
        (record.dlcEvidence ? "厂商合集目录已读 · " + record.dlcEvidence.files.length + " 文件" : record.routeLinks.length ? "官网中转入口 " + record.routeLinks.length + " 条 · 最终网盘待核" : "未见明确中转入口或尚未抓取") +
        "</small></div><div class='link-review-actions'><a href='" + escapeHtml(record.sourceUrl) + "' target='_blank' rel='noopener'>官网</a>" +
        (record.routeLinks[0] ? "<a href='" + escapeHtml(record.routeLinks[0]) + "' target='_blank' rel='noopener'>中转</a>" : "") + "</div></article>";
    }).join("");
    var proposals = batchMatches.length ? "<div class='match-output'><div class='workbench-heading'><h3>匹配建议 · " + batchMatches.length + " 行</h3><button type='button' data-workbench='export'>导出待审 JSON</button></div>" +
      batchMatches.map(function (item) {
        return "<article class='match-row'><span class='badge " + (item.status === "高置信待核" ? "high" : "warning") + "'>" + escapeHtml(item.status) + "</span><div><strong>" + escapeHtml(item.label || item.input) + "</strong><p>" + escapeHtml(item.articleTitle || "尚未匹配文章") + (item.fileName ? " · 文件：" + escapeHtml(item.fileName) : "") + "</p><small>" + escapeHtml(item.note) + "</small></div></article>";
      }).join("") + "</div>" : "";
    var replacementResult = replacementPreview ? "<div class='match-output'>" +
      (replacementPreview.errors.length ? replacementPreview.errors.map(function (error) { return "<p class='workbench-error'>" + escapeHtml(error) + "</p>"; }).join("") :
        "<p class='workbench-count'>" + replacementPreview.audit.reduce(function (sum, row) { return sum + row.plainCount + row.htmlEscapedCount; }, 0) + " 处命中；" + replacementPreview.audit.filter(function (row) { return row.status !== "预览已替换"; }).length + " 组原文未找到。仅预览，未改原文件或面板数据。</p>" +
        replacementPreview.audit.map(function (row) { return "<p class='workbench-count'>" + escapeHtml(row.status) + " · " + (row.plainCount + row.htmlEscapedCount) + " 处 · " + escapeHtml(row.oldUrl) + " → " + escapeHtml(row.newUrl) + "</p>"; }).join("") +
        "<textarea id='replacementOutput' rows='8' readonly>" + escapeHtml(replacementPreview.text) + "</textarea><button type='button' data-workbench='export-replacement'>下载替换预览 TXT</button>") + "</div>" : "";
    $("#linkWorkbench").innerHTML =
      "<div class='workbench-summary'><div><strong>" + DATA.stats.dlcCatalog + "</strong><span>官网文章</span></div><div><strong>" + DATA.stats.dlcWithIntermediate + "</strong><span>文章含中转入口</span></div><div><strong>" + DATA.stats.dlcUniqueIntermediate + "</strong><span>去重中转 URL</span></div><div><strong>" + DATA.stats.dlcFinalShares + "</strong><span>已解析的最终网盘分享</span></div><div><strong>" + DATA.stats.dlcCloudGames + "</strong><span>已对应游戏目录</span></div></div>" +
      "<p class='workbench-note'>当前只有 " + DATA.stats.dlcCloudCollections + " 个厂商合集最终分享被读取公开目录；" + DATA.stats.dlcCloudFiles + " 个游戏目录文件中，" + DATA.stats.dlcNamedPatchFiles + " 个仅凭文件名归为 DLC 相关补丁/分组/增量，其余是说明、演示、配置、工具等，不是‘漏匹配的 DLC’。中转页或网盘页面可达都不代表文件可用或内容合法。</p>" +
      "<section class='workbench-block'><div class='workbench-heading'><div><p class='eyebrow'>01 · SOURCE</p><h2>按文章核对原链接</h2></div><p>官网、中转和最终分享分别记录；不要把中转页当成已核验网盘。</p></div><div class='workbench-filters'><input id='workbenchSearch' type='search' placeholder='筛选游戏或文章标题' value='" + escapeHtml(workbenchSearch) + "'><select id='workbenchStatus'><option value='route'" + (workbenchStatus === "route" ? " selected" : "") + ">有中转、无最终目录</option><option value='no-route'" + (workbenchStatus === "no-route" ? " selected" : "") + ">未见中转</option><option value='cloud'" + (workbenchStatus === "cloud" ? " selected" : "") + ">已读合集目录</option><option value='all'" + (workbenchStatus === "all" ? " selected" : "") + ">全部文章</option></select></div><p class='workbench-count'>符合条件 " + filtered.length + " 篇；显示前 " + Math.min(36, filtered.length) + " 篇。</p><div class='link-review-list'>" + cards + "</div></section>" +
      "<section class='workbench-block'><div class='workbench-heading'><div><p class='eyebrow'>02 · MATCH</p><h2>批量分享标题匹配</h2></div><p>本页本地处理，不会上传或保存粘贴的链接；导出后仍需逐条核验。</p></div><p class='workbench-note'>每行格式：<code>游戏/原文件名 | size=字节数 | https://真实网盘分享</code>。有逐文件 <code>jfile-…</code> 对应码时可放在名称里。仅有域名或中转链接不能替换。</p><textarea id='batchLinkInput' rows='8' placeholder='例如：游戏名/原文件名.zip | size=1234567 | https://pan.quark.cn/s/…'>" + escapeHtml(batchInputValue) + "</textarea><div class='workbench-controls'><button type='button' class='primary' data-workbench='match'>生成匹配建议</button><small>最多处理前 500 行；不会修改官网或原链接。</small></div>" + proposals + "</section>" +
      "<section class='workbench-block'><div class='workbench-heading'><div><p class='eyebrow'>03 · REPLACE</p><h2>旧链接精确替换预览</h2></div><p>给出你自己的文章文本与旧、新链接映射；保留原文，不改第三方网站。</p></div><p class='workbench-note'>映射每行格式：<code>完整旧链接 | 完整新链接</code>，支持 <code>magnet:?</code> 或 HTTPS 旧链接。只替换原文中实际存在的完整链接，不按域名模糊替换；新分享是否可用仍需核验。</p><textarea id='replacementSource' rows='6' placeholder='粘贴你要改写的文章文本或 HTML'>" + escapeHtml(replacementSource) + "</textarea><textarea id='replacementMap' rows='4' placeholder='https://旧链接 | https://新链接'>" + escapeHtml(replacementMap) + "</textarea><div class='workbench-controls'><button type='button' class='primary' data-workbench='preview-replacement'>生成替换预览</button><small>仅在当前浏览器中处理，不会自动发布或写回。</small></div>" + replacementResult + "</section>";
  }

  function render() {
    var config = viewConfig[state.view];
    var items = config.items;
    var monitoring = state.view === "monitor";
    var workbench = state.view === "link-workbench";
    $("#pageTitle").textContent = config.title;
    $("#monitorPanel").hidden = !monitoring;
    $("#linkWorkbench").hidden = !workbench;
    $(".control-deck").hidden = monitoring || workbench;
    $(".result-heading").hidden = monitoring || workbench;
    $("#authorButtons").parentElement.hidden = monitoring || workbench;
    $$(".nav-item").forEach(function (button) {
      button.classList.toggle("active", button.dataset.view === state.view);
    });
    if (monitoring) {
      resultGrid.hidden = true;
      pagination.hidden = true;
      $("#emptyState").hidden = true;
      clearSelection();
      renderMonitor();
      saveState();
      return;
    }
    if (workbench) {
      resultGrid.hidden = true;
      pagination.hidden = true;
      $("#emptyState").hidden = true;
      clearSelection();
      renderWorkbench();
      saveState();
      return;
    }
    sourceOptions(items);
    contextualFilterOptions();
    renderAuthorButtons(items);

    $("#resultContext").textContent = config.context;
    $("#resultHint").textContent = config.hint;
    $("#searchInput").value = state.search;
    $("#linkFilter").value = state.link;
    $("#confidenceFilter").value = state.confidence;
    $("#sortFilter").value = state.sort;
    $("#linkFilter").disabled = ["bilibili", "dlc"].includes(state.view);
    $("#confidenceFilter").disabled = ["bilibili", "dlc"].includes(state.view);
    resultGrid.classList.toggle("list-layout", state.layout === "list");
    $("#layoutToggle").innerHTML = state.layout === "grid" ? "<span aria-hidden='true'>☷</span>" : "<span aria-hidden='true'>▦</span>";
    $("#layoutToggle").setAttribute("aria-label", state.layout === "grid" ? "切换列表布局" : "切换卡片布局");

    var filtered = filterItems();
    $("#resultCount").textContent = filtered.length;
    $("#emptyState").hidden = filtered.length > 0;
    resultGrid.hidden = filtered.length === 0;

    var visible = filtered;
    if (["bilibili", "dlc", "other-mod"].includes(state.view)) {
      var start = (state.page - 1) * pageSize;
      visible = filtered.slice(start, start + pageSize);
    }
    resultGrid.innerHTML = visible.map(state.view === "bilibili" ? biliCard : state.view === "dlc" ? dlcCard : state.view === "other-mod" ? otherModCard : resourceCard).join("");
    renderPagination(filtered.length);
    updateBulkBar();
    saveState();
  }

  function metadataMarkup(record) {
    var data = Object.assign({
      "作者": record.author,
      "来源": record.sourceType,
      "游戏 / 分类": record.game || record.category,
      "状态": record.status,
      "匹配置信度": confidenceLabels[record.confidence] || record.confidence,
      "BVID": record.bvid,
      "发布时间": record.publishedAt,
      "更新日期": record.updatedAt
    }, record.metadata || {});
    return Object.entries(data)
      .filter(function (pair) { return pair[1] != null && String(pair[1]).trim() !== ""; })
      .map(function (pair) {
        return "<div><dt>" + escapeHtml(pair[0]) + "</dt><dd>" + escapeHtml(pair[1]) + "</dd></div>";
      }).join("");
  }

  function linkCards(record) {
    var html = (record.links || []).map(function (link, index) {
      var unavailable = ["cancelled", "not_found", "restricted_or_empty", "access_restricted", "empty"].includes(link.liveStatus);
      return "<article class='link-card'>" +
        "<div class='link-card-head'><span>" + escapeHtml(link.provider + " · " + (roleLabels[link.role] || link.role || "资源")) + "</span><small>" + escapeHtml(link.code ? "提取码 " + link.code : "无提取码") + "</small></div>" +
        "<code class='link-url'>" + escapeHtml(link.url) + "</code>" +
        (link.status ? "<p class='link-status'>" + escapeHtml(link.status) + (link.checkedAt ? "<br>核验：" + escapeHtml(link.checkedAt) : "") + "</p>" : "") +
        "<div class='link-card-actions'>" +
          "<button type='button' data-detail-action='copy-one-link' data-link-index='" + index + "'>复制分享信息</button>" +
          (unavailable ? "<span class='link-disabled'>不可作为可用链接</span>" : "<a class='primary' href='" + escapeHtml(link.url) + "' target='_blank' rel='noopener'>打开链接</a>") +
        "</div>" +
      "</article>";
    }).join("");
    if (record.biliLinks && record.biliLinks.length) {
      html += record.biliLinks.map(function (link) {
        return "<article class='link-card'>" +
          "<div class='link-card-head'><span>" + escapeHtml(link.type || "B站视频") + " · 标题候选</span><small>" + escapeHtml(link.bvid) + "</small></div>" +
          "<code class='link-url'>" + escapeHtml(link.title || link.url) + "</code>" +
          "<div class='link-card-actions'><button type='button' data-detail-action='copy-plain' data-value='" + escapeHtml(link.url) + "'>复制链接</button><a href='" + escapeHtml(link.url) + "' target='_blank' rel='noopener'>打开视频</a></div>" +
        "</article>";
      }).join("");
    }
    if (record.url) {
      html += "<article class='link-card'><div class='link-card-head'><span>B站视频</span><small>" + escapeHtml(record.bvid) + "</small></div><code class='link-url'>" + escapeHtml(record.url) + "</code><div class='link-card-actions'><button type='button' data-detail-action='copy-plain' data-value='" + escapeHtml(record.url) + "'>复制链接</button><a href='" + escapeHtml(record.url) + "' target='_blank' rel='noopener'>打开视频</a></div></article>";
    }
    if (record.sourceUrl) {
      html += "<article class='link-card'><div class='link-card-head'><span>来源页面</span><small>原始记录</small></div><code class='link-url'>" + escapeHtml(record.sourceUrl) + "</code><div class='link-card-actions'><button type='button' data-detail-action='copy-plain' data-value='" + escapeHtml(record.sourceUrl) + "'>复制链接</button><a href='" + escapeHtml(record.sourceUrl) + "' target='_blank' rel='noopener'>打开来源</a></div></article>";
    }
    if (record.routeLinks && record.routeLinks.length) {
      html += record.routeLinks.map(function (url) {
        return "<article class='link-card'><div class='link-card-head'><span>官网中转入口</span><small>非最终网盘</small></div><code class='link-url'>" + escapeHtml(url) + "</code><p class='link-status'>扫码、风控或页面可达均不能证明文件可用。</p><div class='link-card-actions'><a href='" + escapeHtml(url) + "' target='_blank' rel='noopener'>打开中转页</a></div></article>";
      }).join("");
    }
    return html || "<p class='card-summary'>该记录没有可打开的链接。</p>";
  }

  function galleryMarkup(record) {
    var images = record.images && record.images.length ? record.images : [];
    if (!images.length && (record.coverOriginal || record.cover)) {
      images = [{ label: "封面", url: record.coverOriginal, local: record.cover }];
    }
    if (!images.length) return "<p class='card-summary'>该记录没有匹配到图片。</p>";
    return images.map(function (image, index) {
      var src = image.local || image.url;
      return "<article class='gallery-item'>" +
        "<img loading='lazy' src='" + escapeHtml(src) + "' alt='" + escapeHtml(record.title + " " + image.label) + "'>" +
        "<footer><span>" + escapeHtml(image.label || "图片 " + (index + 1)) + "</span><button type='button' data-detail-action='download-image' data-image-index='" + index + "'>下载原图</button></footer>" +
      "</article>";
    }).join("");
  }

  function dlcEvidenceMarkup(record) {
    var evidence = record.dlcEvidence;
    if (!evidence) return "";
    var claims = evidence.claimedNames.map(function (claim) {
      if (claim.status === "ea_official_catalog") return "• " + claim.chinese + "〔EA 官网中文名〕 · " + claim.original;
      if (claim.status === "manual_explanation_unverified") return "• " + claim.chinese + "〔释义，非官方译名〕 · " + claim.original;
      if (claim.status === "machine_unverified") return "• " + claim.chinese + "〔机译待核〕 · " + claim.original;
      if (claim.status === "author_includes_chinese") return "• " + claim.original;
      return "• " + claim.original + "〔中文待核〕";
    }).join("\n");
    var files = evidence.files.map(function (file) {
      var size = file.sizeBytes ? " · " + (file.sizeBytes / 1048576).toFixed(file.sizeBytes >= 1048576 ? 1 : 3) + " MiB" : "";
      return "<article class='file-ledger-item'><h4>" + escapeHtml(file.suggestedTitle || file.name) + "</h4>" +
        "<p>原始路径：" + escapeHtml(file.path) + size + "</p>" +
        "<p>原路径码：<code>" + escapeHtml(file.sourcePathId || "未生成") + "</code> · 此快照对应码：<code>" + escapeHtml(file.sourceFileId || "未生成") + "</code> · " + escapeHtml(file.kind || "未分类") + "</p>" +
        "<p>" + escapeHtml(file.suggestedIntro || "介绍待补。") + "</p>" +
      "</article>";
    }).join("");
    var textFiles = evidence.textFiles.length ? evidence.textFiles.map(function (name) { return "• " + name; }).join("\n") : "该游戏目录没有 .txt/.md/.nfo/.html 文件。";
    var notes = evidence.folderNotes.length ? "<p class='evidence-note'>目录提示：" + escapeHtml(evidence.folderNotes.join("；")) + "</p>" : "";
    var updateNotes = evidence.updateNotes && evidence.updateNotes.length
      ? "<p class='evidence-note'>作者在该游戏目录声称：" + escapeHtml(evidence.updateNotes.join("；")) + "。这是游戏级提示，未标明具体属于下列哪个文件，也未核实包内差异。</p>"
      : "<p class='evidence-note'>当前目录未找到明确的“已更新某 DLC”提示；不能由文件日期或网盘修改时间推断更新内容。</p>";
    return "<section class='detail-section'><h3>厂商合集 · 该游戏文件夹</h3>" +
      "<p class='evidence-note'>" + escapeHtml(evidence.collectionKey + " / " + evidence.gameFolder) + "。一个夸克链接覆盖多个游戏，本页仅展示这个游戏的子目录。目录核验：" + escapeHtml(evidence.checkedAt) + "。涉及付费 DLC 时请核对购买与使用权属；本站不提供解锁操作或安全保证。</p>" +
      notes +
      "<div class='update-evidence'><h4>DLC 更新说明</h4>" + updateNotes + "<p class='evidence-note'>要确认具体更新项，仍需取得逐文件更新日志或包内清单，与上一版及官方 DLC 名称逐项对照；目前标记为待核，不能写“全 DLC 已更新”。</p></div>" +
      "<details class='evidence-fold' open><summary>官网声称的内容 · " + evidence.claimedNames.length + " 项（仅供参考）</summary><p class='evidence-note'>来自作者官网 RSS；可能混有预购奖励、原声、捆绑包和非 DLC 项。中文名称按作者原文、EA 官网、人工释义或机译分别标注；始终保留英文原名，不能据此推断补丁实际解锁。" + (evidence.gameFolder.includes("The Sims 4") ? " <a href='https://www.ea.com/zh-hans/games/the-sims/the-sims-4/store' target='_blank' rel='noopener'>EA 官方商城 ↗</a>" : "") + "</p><div class='content-box evidence-list'>" + escapeHtml(claims || "官网未列出具体清单") + "</div></details>" +
      "<details class='evidence-fold'><summary>逐文件对应台账与建议标题 · " + evidence.files.length + " 个</summary><p class='evidence-note'>对应码用于以后把你单独分享的文件按原始路径和字节大小配对。建议标题、介绍仅据文件名生成，不是已验证的 DLC 更新公告；旧版、工具和独立文件不能相加为一个“全 DLC 包”。当前没有逐文件分享链接。</p><div class='file-ledger'>" + files + "</div></details>" +
      "<details class='evidence-fold'><summary>说明文本文件名 · " + evidence.textFiles.length + " 个</summary><p class='evidence-note'>" + escapeHtml(evidence.textContentStatus) + "；下列只是文件名，不是文本正文。</p><div class='content-box evidence-list'>" + escapeHtml(textFiles) + "</div></details>" +
    "</section>";
  }

  function openDetails(record, trigger) {
    activeRecord = record;
    lastFocused = trigger || document.activeElement;
    var hero = record.cover || record.coverOriginal;
    var subtitle = record.videoTitle || record.summary || record.bvid || "原始采集记录";
    var description = record.description || "该来源未采集到介绍。";
    detailContent.innerHTML =
      "<section class='detail-hero'>" +
        (hero ? "<img src='" + escapeHtml(hero) + "' alt=''>" : "") +
        "<div class='detail-hero-content'>" +
          "<div class='badge-row'><span class='badge quark'>" + escapeHtml(record.sourceType || "B站投稿") + "</span>" +
          (record.confidence ? confidenceBadge(record) : "") +
          (record.status ? "<span class='badge'>" + escapeHtml(record.status) + "</span>" : "") +
          "</div>" +
          "<h2>" + escapeHtml(record.title) + "</h2>" +
          "<p>" + escapeHtml(subtitle) + "</p>" +
        "</div>" +
      "</section>" +
      "<div class='detail-body'>" +
        "<div>" +
          "<section class='detail-section'>" +
            "<h3>介绍 / 内容</h3>" +
            "<div class='detail-actions'>" +
              "<button type='button' data-detail-action='copy-title'>复制标题</button>" +
              "<button type='button' data-detail-action='copy-content'" + (!record.description ? " disabled" : "") + ">复制完整介绍</button>" +
              "<button type='button' class='primary' data-detail-action='copy-full'>复制标题 + 内容</button>" +
              "<button type='button' data-detail-action='download-cover'" + (!(record.coverOriginal || record.cover) ? " disabled" : "") + ">下载封面</button>" +
            "</div>" +
            "<div class='content-box'>" + escapeHtml(description) + "</div>" +
          "</section>" +
          dlcEvidenceMarkup(record) +
          "<section class='detail-section'><h3>图片素材 · " + ((record.images && record.images.length) || (hero ? 1 : 0)) + " 张</h3><div class='gallery'>" + galleryMarkup(record) + "</div></section>" +
        "</div>" +
        "<aside>" +
          "<section class='detail-section'><h3>链接</h3><div class='link-stack'>" + linkCards(record) + "</div></section>" +
          "<section class='detail-section'><h3>记录信息</h3><dl class='metadata-list'>" + metadataMarkup(record) + "</dl>" +
          (record.matchNote ? "<div class='content-box' style='margin-top:14px;max-height:180px'>" + escapeHtml(record.matchNote) + "</div>" : "") +
          "</section>" +
        "</aside>" +
      "</div>";
    detailDialog.showModal();
    $(".dialog-close", detailDialog).focus();
  }

  function updateBulkBar() {
    $("#selectedCount").textContent = selected.size;
    $("#bulkBar").hidden = selected.size === 0;
  }

  function clearSelection() {
    selected.clear();
    updateBulkBar();
    $$("[data-select]").forEach(function (input) { input.checked = false; });
  }

  function resetFilters() {
    state.author = "all";
    state.search = "";
    state.source = "all";
    state.link = "all";
    state.confidence = "all";
    state.sort = "default";
    state.page = 1;
    clearSelection();
    render();
  }

  resultGrid.addEventListener("click", function (event) {
    var action = event.target.closest("[data-action]");
    if (!action) return;
    var card = action.closest("[data-id]");
    var record = card && recordById(card.dataset.id);
    if (!record) return;
    var type = action.dataset.action;
    if (type === "copy-title") copyText(record.title, "标题");
    if (type === "copy-share") {
      var share = record.links[0];
      copyText(share.provider + "：" + share.url + (share.code ? "\n提取码：" + share.code : "") + "\n核验：" + share.status, "网盘分享信息");
    }
    if (type === "copy-content") copyText(record.description, "完整介绍");
    if (type === "copy-links") copyText(linksText(record), "夸克分享信息");
    if (type === "download-cover") downloadImage(record.cover || record.coverOriginal, record.title + "_封面");
    if (type === "details") openDetails(record, action);
    if (type === "open-bili") window.open(record.url, "_blank", "noopener");
  });

  resultGrid.addEventListener("change", function (event) {
    if (!event.target.matches("[data-select]")) return;
    if (event.target.checked) selected.add(event.target.dataset.select);
    else selected.delete(event.target.dataset.select);
    updateBulkBar();
  });

  $("#authorButtons").addEventListener("click", function (event) {
    var button = event.target.closest("[data-author]");
    if (!button) return;
    state.author = button.dataset.author;
    state.page = 1;
    clearSelection();
    render();
  });

  $("#linkWorkbench").addEventListener("input", function (event) {
    if (event.target.id === "batchLinkInput") batchInputValue = event.target.value;
    if (event.target.id === "replacementSource") replacementSource = event.target.value;
    if (event.target.id === "replacementMap") replacementMap = event.target.value;
    if (event.target.id === "workbenchSearch") {
      workbenchSearch = event.target.value;
      var cursor = event.target.selectionStart;
      renderWorkbench();
      $("#workbenchSearch").focus();
      $("#workbenchSearch").setSelectionRange(cursor, cursor);
    }
  });
  $("#linkWorkbench").addEventListener("change", function (event) {
    if (event.target.id === "workbenchStatus") { workbenchStatus = event.target.value; renderWorkbench(); }
  });
  $("#linkWorkbench").addEventListener("click", function (event) {
    var button = event.target.closest("[data-workbench]");
    if (!button) return;
    if (button.dataset.workbench === "match") runBatchMatch();
    if (button.dataset.workbench === "preview-replacement") prepareReplacement();
    if (button.dataset.workbench === "export-replacement" && replacementPreview && !replacementPreview.errors.length) {
      var previewBlob = new Blob([replacementPreview.text], { type: "text/plain;charset=utf-8" });
      var previewHref = URL.createObjectURL(previewBlob);
      var previewLink = document.createElement("a");
      previewLink.href = previewHref;
      previewLink.download = "链接替换预览_" + new Date().toISOString().slice(0, 10) + ".txt";
      previewLink.click();
      setTimeout(function () { URL.revokeObjectURL(previewHref); }, 1000);
    }
    if (button.dataset.workbench === "export") {
      if (!batchMatches.length) return;
      var exportData = { createdAt: new Date().toISOString(), source: "面板本地批量匹配建议", caveat: "未验证网盘文件、版本、授权或安全；未替换任何原链接", proposals: batchMatches };
      var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json;charset=utf-8" });
      var href = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = href;
      link.download = "非线性列车_补链待审_" + new Date().toISOString().slice(0, 10) + ".json";
      link.click();
      setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
    }
  });

  $$(".nav-item").forEach(function (button) {
    button.addEventListener("click", function () {
      state.view = button.dataset.view;
      state.author = "all";
      state.source = "all";
      state.link = "all";
      state.confidence = "all";
      state.page = 1;
      clearSelection();
      render();
    });
  });

  $("#searchInput").addEventListener("input", function (event) {
    state.search = event.target.value;
    state.page = 1;
    render();
  });

  [
    ["#sourceFilter", "source"],
    ["#linkFilter", "link"],
    ["#confidenceFilter", "confidence"],
    ["#sortFilter", "sort"]
  ].forEach(function (binding) {
    $(binding[0]).addEventListener("change", function (event) {
      state[binding[1]] = event.target.value;
      state.page = 1;
      render();
    });
  });

  $("#resetButton").addEventListener("click", resetFilters);
  $("#layoutToggle").addEventListener("click", function () {
    state.layout = state.layout === "grid" ? "list" : "grid";
    render();
  });

  $("#emptyState").addEventListener("click", function (event) {
    if (event.target.matches("[data-action='reset']")) resetFilters();
  });

  pagination.addEventListener("click", function (event) {
    var button = event.target.closest("[data-page]");
    if (!button) return;
    state.page = Number(button.dataset.page);
    render();
    $(".result-heading").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#bulkBar").addEventListener("click", function (event) {
    var button = event.target.closest("[data-bulk]");
    if (!button) return;
    var records = Array.from(selected).map(recordById).filter(Boolean);
    if (button.dataset.bulk === "clear") {
      clearSelection();
      return;
    }
    if (button.dataset.bulk === "titles") {
      copyText(records.map(function (record) { return record.title; }).join("\n"), "已选标题");
    }
    if (button.dataset.bulk === "links") {
      var text = records.map(linksText).filter(Boolean).join("\n\n");
      copyText(text, "已选夸克分享信息");
    }
    if (button.dataset.bulk === "content") {
      copyText(records.map(shareText).join("\n\n————————\n\n"), "已选资源内容");
    }
  });

  detailDialog.addEventListener("click", function (event) {
    if (event.target === detailDialog || event.target.closest("[data-action='close-dialog']")) {
      detailDialog.close();
      return;
    }
    var button = event.target.closest("[data-detail-action]");
    if (!button || !activeRecord) return;
    var action = button.dataset.detailAction;
    if (action === "copy-title") copyText(activeRecord.title, "标题");
    if (action === "copy-content") copyText(activeRecord.description, "完整介绍");
    if (action === "copy-full") copyText(shareText(activeRecord), "标题和内容");
    if (action === "download-cover") downloadImage(activeRecord.cover || activeRecord.coverOriginal, activeRecord.title + "_封面");
    if (action === "copy-plain") copyText(button.dataset.value, "链接");
    if (action === "copy-one-link") {
      var link = activeRecord.links[Number(button.dataset.linkIndex)];
      var text = "标题：" + activeRecord.title + "\n类型：" + (roleLabels[link.role] || link.role || "资源") + "\n" + link.provider + "：" + link.url + (link.code ? "\n提取码：" + link.code : "") + (link.status ? "\n状态：" + link.status : "") + (link.checkedAt ? "\n核验时间：" + link.checkedAt : "");
      copyText(text, "分享信息");
    }
    if (action === "download-image") {
      var image = activeRecord.images[Number(button.dataset.imageIndex)];
      downloadImage(image.url || image.local, activeRecord.title + "_" + (image.label || "图片"));
    }
  });

  detailDialog.addEventListener("close", function () {
    activeRecord = null;
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  });

  $("#copyFallback").addEventListener("click", function (event) {
    if (event.target === event.currentTarget || event.target.matches("[data-action='close-fallback']")) {
      $("#copyFallback").hidden = true;
    }
  });

  document.addEventListener("keydown", function (event) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
      event.preventDefault();
      $("#searchInput").focus();
    }
    if (event.key === "Escape" && !$("#copyFallback").hidden) {
      $("#copyFallback").hidden = true;
    }
  });

  $("#navResourceCount").textContent = DATA.stats.resources + " 条主资源";
  $("#navCandidateCount").textContent = DATA.stats.candidateResources + " 条候选";
  $("#navOtherModCount").textContent = DATA.stats.otherModLinks + " 条网盘入口";
  $("#navBoxCount").textContent = DATA.stats.boxRecords + " 条公开作品";
  $("#navBiliCount").textContent = DATA.stats.biliVideos + " 条投稿";
  $("#navDlcCount").textContent = DATA.stats.dlcCatalog + " 篇官网目录";
  $("#navWatchCount").textContent = DATA.stats.watchAuthors + " 位作者";
  $("#metricPrimary").textContent = DATA.stats.resources;
  $("#metricQuark").textContent = DATA.stats.quarkRecords;
  $("#metricCovers").textContent = DATA.stats.localCovers;
  $("#metricBili").textContent = DATA.stats.biliVideos;

  render();
})();
