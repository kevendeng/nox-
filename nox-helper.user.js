// ==UserScript==
// @name         NoxInfluencer Helper
// @namespace    http://tampermonkey.net/
// @version      9.1
// @description  auto collect (via API) and keyword input on the search page
// @match        https://cn.noxinfluencer.com/search/*
// @match        https://cn.noxinfluencer.com/lookalike/*
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/kevendeng/nox-/main/nox-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/kevendeng/nox-/main/nox-helper.user.js
// ==/UserScript==
(function () {
    'use strict';
    // 统一版本号:以后升级只改这一处(以及头部 @version),面板标题/日志会自动跟着变,
    // 避免出现“头部 8.6、面板还写 8.5”这种对不上的情况。
    var SCRIPT_VERSION = '9.1';
    console.log('Nox helper V' + SCRIPT_VERSION + ' started');
    var isScriptRunning = false;
    var stopRequested = false;
    var totalUsersChecked = 0;
    var maxCheckLimit = 1000;
    var CHECK_DELAY = 800;
    var NEXT_PAGE_WAIT_TIME = 2500;
    function sleep(ms) {
        return new Promise(function (resolve, reject) {
            if (stopRequested) return reject(new Error('stopped'));
            setTimeout(function () {
                if (stopRequested) return reject(new Error('stopped'));
                resolve();
            }, ms);
        });
    }
    function sleepPlain(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function isElementVisible(elem) {
        if (!elem) return false;
        var rect = elem.getBoundingClientRect();
        return (rect.width > 0 && rect.height > 0 && window.getComputedStyle(elem).display !== 'none');
    }
    async function waitForPageReady(timeout) {
        timeout = timeout || 20000;
        var startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            if (stopRequested) throw new Error('stopped');
            var items = document.querySelectorAll('.youtube-channel-item');
            var selectAll = document.querySelector('.result-pagination-left .el-checkbox__input');
            if (items.length > 0 && selectAll) { await sleep(1000); return true; }
            await sleep(500);
        }
        return false;
    }
    // 平台编号:instagram=6(已确认)。其它平台的值待确认，先按常见约定猜，认不出时兜底 6 并在控制台提示。
    // 从当前网址自动识别，用户无需手动输入。
    var PLATFORM_MAP = { instagram: 6, youtube: 1, tiktok: 10, twitter: 3, twitch: 5 };
    function getPlatformFromUrl() {
        var m = location.pathname.match(/\/search\/([^\/]+)/) || location.pathname.match(/\/lookalike\/([^\/]+)/);
        var key = m ? m[1].toLowerCase() : '';
        if (PLATFORM_MAP[key]) return PLATFORM_MAP[key];
        console.log('[collect] 未知平台"' + key + '"，暂用 6(instagram)。如收藏到错平台请反馈。');
        return 6;
    }
    // 拉取收藏夹列表(名字→ID)。返回 [{id, name, remainder, createTime}, ...]，按创建时间倒序(最新在前)。
    var __noxGroupCache = null;
    var FOLDER_CAP = 5000; // 每个收藏夹固定容量上限
    async function fetchGroups(force) {
        if (__noxGroupCache && !force) return __noxGroupCache;
        var res = await fetch('https://cn.noxinfluencer.com/ws/collection/simpleGroupList', { credentials: 'include' });
        var d = await res.json();
        var arr = (d && d.retDataList) || [];
        arr = arr.map(function (g) {
            // filled = 已填入人数 = 上限 - 剩余。用户关心的是“已经装了多少人”，不是剩余额度。
            var rem = (g.remainder != null) ? g.remainder : null;
            var filled = (rem != null) ? (FOLDER_CAP - rem) : null;
            return { id: g.id, name: g.name, remainder: rem, filled: filled, createTime: g.createTime || 0 };
        }).sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
        __noxGroupCache = arr;
        return arr;
    }
    // 只抓“可见”达人的 channelId。被隐藏(建联过/已合作)的达人带 .youtube-channel-fade，一律排除。
    // 再叠加 offsetParent 判断作双保险。channelId 从卡片里 /channel/<id> 链接抠出。
    // 注意:不同平台 id 格式不同——instagram 是纯数字(20575005572)，YouTube 是 UCxxx 字母串。
    // 所以匹配 /channel/ 后到下一个斜杠/问号/井号前的整段，不能只认数字。
    function getVisibleChannelIds() {
        var items = document.querySelectorAll('.youtube-channel-item:not(.youtube-channel-fade)');
        var ids = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.offsetParent === null) continue; // 双保险:确实在页面上渲染出来的
            var a = item.querySelector('a[href*="/channel/"]');
            if (!a) continue;
            var mm = (a.getAttribute('href') || '').match(/\/channel\/([^\/?#]+)/);
            if (mm) ids.push(mm[1]);
        }
        // 去重(卡片里有多个同 id 链接)
        var seen = {}, out = [];
        for (var j = 0; j < ids.length; j++) { if (!seen[ids[j]]) { seen[ids[j]] = 1; out.push(ids[j]); } }
        return out;
    }
    // 智能等待本页渲染稳定：不仅要有卡片，还要“可见达人数量”连续几次不变，
    // 确保 .youtube-channel-fade(隐藏标记)已经渲染上去——否则会抢在隐藏生效前把建联过的人误当可见。
    async function waitForCollectPageReady(timeout) {
        timeout = timeout || 25000;
        var startTime = Date.now();
        var lastCount = -1, stableTimes = 0;
        while (Date.now() - startTime < timeout) {
            if (stopRequested) throw new Error('stopped');
            var items = document.querySelectorAll('.youtube-channel-item');
            if (items.length > 0) {
                var visCount = getVisibleChannelIds().length;
                if (visCount === lastCount) {
                    stableTimes++;
                    // 连续 3 次(约 1.2s)可见数不变，认定渲染稳定
                    if (stableTimes >= 3) return true;
                } else {
                    stableTimes = 0;
                    lastCount = visCount;
                }
            }
            await sleep(400);
        }
        // 超时也返回当前状态(有卡片就继续，靠上面的稳定判断已尽量兜住)
        return document.querySelectorAll('.youtube-channel-item').length > 0;
    }
    // 调收藏接口:一次把本页可见达人加入指定收藏夹。同源 fetch，鉴权靠 cookie 自动带。
    async function collectViaApi(ids, groupIds, platform) {
        var res = await fetch('https://cn.noxinfluencer.com/ws/collection', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ channelIds: ids, platform: platform, groupIds: groupIds })
        });
        var body = null;
        try { body = await res.json(); } catch (e) { try { body = await res.text(); } catch (e2) { body = null; } }
        return { status: res.status, body: body };
    }
    // 处理当前页:等渲染稳 → 抓可见 id(不超过剩余名额) → 调接口收藏。返回本页实际收藏数。
    async function processCurrentPage() {
        if (totalUsersChecked >= maxCheckLimit) { stopRequested = true; return 0; }
        setCollectStatus('第' + currentPageNum + '页：等待渲染…');
        var isReady = await waitForCollectPageReady();
        if (!isReady) { setCollectStatus('第' + currentPageNum + '页：未渲染出结果'); return 0; }
        var ids = getVisibleChannelIds();
        if (!ids.length) { setCollectStatus('第' + currentPageNum + '页：本页无可见达人(全隐藏)，跳过'); return 0; }
        var remaining = maxCheckLimit - totalUsersChecked;
        if (ids.length > remaining) ids = ids.slice(0, remaining);
        setCollectStatus('第' + currentPageNum + '页：收藏 ' + ids.length + ' 个…');
        var r = await collectViaApi(ids, collectGroupIds, collectPlatform);
        if (r.status !== 200) {
            throw new Error('收藏接口返回 ' + r.status + '，已停止。请检查登录状态或收藏夹。');
        }
        totalUsersChecked += ids.length;
        updateButtonText();
        setCollectStatus('已收藏 ' + totalUsersChecked + '/' + maxCheckLimit + '（第' + currentPageNum + '页 +' + ids.length + '）');
        return ids.length;
    }
    async function goToNextPage() {
        var nextPageButton = document.querySelector('.search-pagination-container .right');
        if (nextPageButton && !nextPageButton.classList.contains('disabled') && isElementVisible(nextPageButton)) {
            nextPageButton.click();
            return true;
        }
        return false;
    }
    var collectGroupIds = [];
    var collectPlatform = 6;
    // 已选收藏夹:{id, name} 数组，由下拉多选维护
    var selectedGroups = [];
    async function startBatchProcess() {
        if (isScriptRunning) return;
        var userLimit = parseInt(limitInput.value, 10);
        if (isNaN(userLimit) || userLimit <= 0) { alert('请输入有效的目标数量'); return; }
        if (!selectedGroups.length) { alert('请先在上面选择要收藏进哪个收藏夹'); return; }
        var groupIds = selectedGroups.map(function (g) { return g.id; });
        var groupNames = selectedGroups.map(function (g) { return g.name; });
        // 平台从当前网址自动识别，用户无需输入
        var platform = getPlatformFromUrl();
        collectGroupIds = groupIds;
        collectPlatform = platform;
        if (!confirm('将把可见达人收藏进：\n' + groupNames.join('、') + '\n目标 ' + userLimit + ' 个。\n(已建联/隐藏的达人会自动跳过) 开始吗？')) return;
        maxCheckLimit = userLimit;
        isScriptRunning = true;
        stopRequested = false;
        totalUsersChecked = 0;
        currentPageNum = 1;
        updateUIStatus(true);
        var stopMsg = '';
        try {
            while (!stopRequested && totalUsersChecked < maxCheckLimit) {
                await processCurrentPage();
                if (stopRequested || totalUsersChecked >= maxCheckLimit) break;
                setCollectStatus('已收藏 ' + totalUsersChecked + '/' + maxCheckLimit + '，翻到第' + (currentPageNum + 1) + '页…');
                var hasNext = await goToNextPage();
                if (!hasNext) { stopMsg = '已到最后一页。'; break; }
                currentPageNum++;
                await sleep(NEXT_PAGE_WAIT_TIME);
            }
        } catch (error) {
            console.log(error.message);
            if (error.message !== 'stopped') stopMsg = error.message;
        } finally {
            isScriptRunning = false;
            updateUIStatus(false);
            setCollectStatus((stopMsg ? stopMsg + ' ' : '') + '完成，共收藏 ' + totalUsersChecked + ' 个');
            // 收藏后刷新收藏夹列表，"已装人数"会更新
            loadGroupsIntoPanel(true);
            alert((stopMsg ? stopMsg + '\n' : '') + '完成，共收藏 ' + totalUsersChecked + ' 个达人。');
        }
    }
    var kwSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    function getKwInput() {
        return document.querySelector('input.search-value-input')
            || document.querySelector('.input-content input')
            || document.querySelector('.input-box input')
            || document.querySelector('.search-input-fix input');
    }
    function focusInputBox() {
        var box = document.querySelector('.input-content')
               || document.querySelector('.input-box')
               || document.querySelector('.search-input-fix');
        if (box) {
            ['mousedown', 'mouseup', 'click'].forEach(function (type) {
                box.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
        }
    }
    async function addWord(kw) {
        var before = document.querySelectorAll('.keywords-item').length;
        for (var t = 0; t < 4; t++) {
            focusInputBox();
            await sleepPlain(350);
            var input = getKwInput();
            if (!input) { await sleepPlain(300); continue; }
            input.focus();
            kwSetter.call(input, kw);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleepPlain(600);
            var evs = ['keydown', 'keypress', 'keyup'];
            for (var k = 0; k < evs.length; k++) {
                input.dispatchEvent(new KeyboardEvent(evs[k], { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
            await sleepPlain(800);
            if (document.querySelectorAll('.keywords-item').length > before) return true;
        }
        return false;
    }
    async function runKeywords() {
        var raw = prompt('Paste keywords, one per line:');
        if (!raw || !raw.trim()) return;
        keywordButton.disabled = true;
        var oldText = keywordButton.textContent;
        function countExclude() { return document.querySelectorAll('.keywords-item.is-exclude').length; }
        var excludeBaseline = countExclude();
        var guard = 0;
        while (guard++ < 60) {
            var normals = document.querySelectorAll('.keywords-item:not(.is-exclude)');
            if (!normals.length) break;
            var item = normals[0];
            var x = item.querySelector('.kol-icon-close-filled') || item.querySelector('[class*="close"]');
            if (!x) break;
            var beforeTotal = document.querySelectorAll('.keywords-item').length;
            x.click();
            await sleepPlain(350);
            if (countExclude() !== excludeBaseline) {
                console.log('[keywords] aborted cleanup: an exclude word was affected');
                break;
            }
            if (document.querySelectorAll('.keywords-item').length >= beforeTotal) break;
        }
        var keywords = raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var failed = [];
        for (var i = 0; i < keywords.length; i++) {
            if (document.querySelectorAll('.keywords-item').length >= 20) {
                for (var j = i; j < keywords.length; j++) failed.push(keywords[j]);
                break;
            }
            keywordButton.textContent = 'adding ' + (i + 1) + '/' + keywords.length;
            var ok = await addWord(keywords[i]);
            if (!ok) failed.push(keywords[i]);
            await sleepPlain(300);
        }
        keywordButton.disabled = false;
        keywordButton.textContent = oldText;
        if (failed.length) alert('Done, but failed: ' + failed.join(', '));
        else alert('All keywords added!');
    }
    var startButton, stopButton, limitInput, controlsDiv, keywordButton;
    var groupFilterInput, groupSelectEl, groupRefreshBtn, groupSelectedLabel, collectStatusEl;
    var currentPageNum = 0;
    function setCollectStatus(t) { if (collectStatusEl) collectStatusEl.textContent = t; }
    function isFolderPage() { return location.href.indexOf('/resource-folder/') !== -1; }
    function isEmailPage() { return location.href.indexOf('/email/') !== -1; }
    function isCrmPage() { return location.href.indexOf('/crm-detail/') !== -1; }
    function currentPageType() {
        if (isFolderPage()) return 'folder';
        if (isEmailPage()) return 'email';
        if (isCrmPage()) return 'crm';
        return 'search';
    }
    function updateUIStatus(running) {
        startButton.disabled = running;
        stopButton.style.display = running ? 'block' : 'none';
        limitInput.disabled = running;
        if (groupSelectEl) groupSelectEl.disabled = running;
        if (groupFilterInput) groupFilterInput.disabled = running;
        if (groupRefreshBtn) groupRefreshBtn.disabled = running;
        if (!running) {
            startButton.textContent = '开始收藏(自动翻页)';
            startButton.style.backgroundColor = '#4CAF50';
        }
    }
    function updateButtonText() {
        if (isScriptRunning) {
            startButton.textContent = '收藏中 (' + totalUsersChecked + '/' + maxCheckLimit + ')';
            startButton.style.backgroundColor = '#FFA500';
        }
    }
    function makeDraggable(panel, handle) {
        var startX, startY, startLeft, startTop, dragging = false;
        try {
            var saved = JSON.parse(localStorage.getItem('nox-panel-pos') || 'null');
            if (saved && typeof saved.left === 'number') {
                panel.style.left = saved.left + 'px';
                panel.style.top = saved.top + 'px';
                panel.style.right = 'auto';
            }
        } catch (e) {}
        handle.addEventListener('mousedown', function (e) {
            dragging = true;
            var rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var newLeft = startLeft + (e.clientX - startX);
            var newTop = startTop + (e.clientY - startY);
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - panel.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - panel.offsetHeight));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
        });
        document.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            try {
                localStorage.setItem('nox-panel-pos', JSON.stringify({
                    left: parseInt(panel.style.left, 10),
                    top: parseInt(panel.style.top, 10)
                }));
            } catch (e) {}
        });
    }
    function initializeControls() {
        if (document.getElementById('nox-script-ui')) return;
        controlsDiv = document.createElement('div');
        controlsDiv.id = 'nox-script-ui';
        controlsDiv.setAttribute('data-page', currentPageType());
        controlsDiv.style.position = 'fixed';
        controlsDiv.style.top = '100px';
        controlsDiv.style.right = '20px';
        controlsDiv.style.zIndex = '2147483647';
        controlsDiv.style.backgroundColor = '#ffffff';
        controlsDiv.style.border = '2px solid #007bff';
        controlsDiv.style.borderRadius = '8px';
        controlsDiv.style.padding = '15px';
        controlsDiv.style.display = 'flex';
        controlsDiv.style.flexDirection = 'column';
        controlsDiv.style.gap = '10px';
        controlsDiv.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
        controlsDiv.style.width = '180px';
        controlsDiv.style.fontFamily = 'sans-serif';
        var title = document.createElement('div');
        title.textContent = '✥ Nox Helper v' + SCRIPT_VERSION + ' (drag)';
        title.style.textAlign = 'center';
        title.style.fontWeight = 'bold';
        title.style.cursor = 'move';
        title.style.userSelect = 'none';
        title.title = 'Drag me to move the panel';
        makeDraggable(controlsDiv, title);
        controlsDiv.appendChild(title);
        buildSearchPanel(controlsDiv);
        document.body.appendChild(controlsDiv);
        console.log('Nox UI mounted v' + SCRIPT_VERSION);
    }
    // 用过滤词刷新下拉里的收藏夹选项。filter 为空则显示最新的 MAX 个。
    function populateGroupOptions(groups, filter) {
        if (!groupSelectEl) return;
        var kw = (filter || '').trim().toLowerCase();
        // 没输过滤词:只显示最新创建的 50 个(倒序,最新在前),保持清爽;
        // 一旦输入过滤词:在全部收藏夹里搜,覆盖全量。
        var shown;
        if (!kw) {
            shown = groups.slice(0, 50);
        } else {
            shown = groups.filter(function (g) {
                return (g.name || '').toLowerCase().indexOf(kw) !== -1;
            });
        }
        // 记住已选中的 id，重建后尽量保持勾选
        var prevSel = {};
        selectedGroups.forEach(function (g) { prevSel[g.id] = 1; });
        groupSelectEl.innerHTML = '';
        shown.forEach(function (g) {
            var opt = document.createElement('option');
            opt.value = String(g.id);
            opt.textContent = g.name + '  (已装' + (g.filled != null ? g.filled : '?') + '人)';
            opt._group = g;
            if (prevSel[g.id]) opt.selected = true;
            groupSelectEl.appendChild(opt);
        });
        if (groupSelectedLabel) groupSelectedLabel.textContent = '';
    }
    function syncSelectedGroups() {
        selectedGroups = [];
        if (!groupSelectEl) return;
        for (var i = 0; i < groupSelectEl.options.length; i++) {
            var o = groupSelectEl.options[i];
            if (o.selected && o._group) selectedGroups.push({ id: o._group.id, name: o._group.name });
        }
        try { localStorage.setItem('nox-collect-group-ids', JSON.stringify(selectedGroups.map(function (g) { return g.id; }))); } catch (e) {}
    }
    async function loadGroupsIntoPanel(force) {
        if (!groupSelectEl) return;
        if (groupSelectedLabel) groupSelectedLabel.textContent = '正在加载收藏夹…';
        try {
            var groups = await fetchGroups(force);
            populateGroupOptions(groups, groupFilterInput ? groupFilterInput.value : '');
        } catch (e) {
            if (groupSelectedLabel) groupSelectedLabel.textContent = '加载收藏夹失败，点🔄重试';
            console.log('[collect] 加载收藏夹失败:', e && e.message);
        }
    }
    function buildSearchPanel(root) {
        root.style.width = '240px';
        keywordButton = document.createElement('button');
        keywordButton.textContent = 'Input keywords';
        keywordButton.style.padding = '10px';
        keywordButton.style.backgroundColor = '#38cb89';
        keywordButton.style.color = 'white';
        keywordButton.style.border = 'none';
        keywordButton.style.borderRadius = '4px';
        keywordButton.style.cursor = 'pointer';
        keywordButton.style.fontWeight = 'bold';
        keywordButton.addEventListener('click', runKeywords);
        var divider = document.createElement('div');
        divider.style.borderTop = '1px dashed #ccc';
        divider.style.margin = '4px 0';
        // 收藏夹选择区
        var groupLabel = document.createElement('span');
        groupLabel.innerHTML = '收藏进哪个收藏夹 <span style="font-weight:normal;color:#888;">(可多选)</span>:';
        groupLabel.style.fontSize = '12px';
        groupLabel.style.fontWeight = 'bold';
        // 过滤 + 刷新一行
        var filterRow = document.createElement('div');
        filterRow.style.display = 'flex';
        filterRow.style.gap = '4px';
        groupFilterInput = document.createElement('input');
        groupFilterInput.type = 'text';
        groupFilterInput.placeholder = '按名字过滤，如 0730';
        groupFilterInput.style.flex = '1';
        groupFilterInput.style.padding = '5px';
        groupFilterInput.style.border = '1px solid #ccc';
        groupFilterInput.style.borderRadius = '4px';
        groupFilterInput.style.minWidth = '0';
        groupFilterInput.addEventListener('input', function () {
            if (__noxGroupCache) populateGroupOptions(__noxGroupCache, groupFilterInput.value);
        });
        groupRefreshBtn = document.createElement('button');
        groupRefreshBtn.textContent = '🔄';
        groupRefreshBtn.title = '重新拉取收藏夹列表(新建后点这个)';
        groupRefreshBtn.style.cssText = 'padding:5px 8px;border:1px solid #ccc;background:#f5f5f5;border-radius:4px;cursor:pointer;';
        groupRefreshBtn.addEventListener('click', function () { loadGroupsIntoPanel(true); });
        filterRow.appendChild(groupFilterInput);
        filterRow.appendChild(groupRefreshBtn);
        // 多选下拉
        groupSelectEl = document.createElement('select');
        groupSelectEl.multiple = true;
        groupSelectEl.size = 6;
        groupSelectEl.style.cssText = 'width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px;box-sizing:border-box;';
        groupSelectEl.addEventListener('change', syncSelectedGroups);
        groupSelectedLabel = document.createElement('div');
        groupSelectedLabel.style.cssText = 'font-size:11px;color:#888;';
        groupSelectedLabel.textContent = '正在加载收藏夹…';
        limitInput = document.createElement('input');
        limitInput.type = 'number';
        limitInput.value = '1000';
        limitInput.style.padding = '5px';
        limitInput.style.border = '1px solid #ccc';
        startButton = document.createElement('button');
        startButton.textContent = '开始收藏(自动翻页)';
        startButton.style.padding = '10px';
        startButton.style.backgroundColor = '#4CAF50';
        startButton.style.color = 'white';
        startButton.style.border = 'none';
        startButton.style.borderRadius = '4px';
        startButton.style.cursor = 'pointer';
        startButton.style.fontWeight = 'bold';
        stopButton = document.createElement('button');
        stopButton.textContent = 'Stop';
        stopButton.style.padding = '8px';
        stopButton.style.backgroundColor = '#f44336';
        stopButton.style.color = 'white';
        stopButton.style.border = 'none';
        stopButton.style.borderRadius = '4px';
        stopButton.style.cursor = 'pointer';
        stopButton.style.display = 'none';
        startButton.addEventListener('click', startBatchProcess);
        stopButton.addEventListener('click', function () { stopRequested = true; });
        root.appendChild(keywordButton);
        root.appendChild(divider);
        root.appendChild(groupLabel);
        root.appendChild(filterRow);
        root.appendChild(groupSelectEl);
        root.appendChild(groupSelectedLabel);
        var label = document.createElement('span');
        label.textContent = '目标数量:';
        label.style.fontSize = '12px';
        root.appendChild(label);
        root.appendChild(limitInput);
        root.appendChild(startButton);
        root.appendChild(stopButton);
        collectStatusEl = document.createElement('div');
        collectStatusEl.style.cssText = 'font-size:12px;color:#4CAF50;text-align:center;min-height:16px;font-weight:bold;';
        collectStatusEl.textContent = '就绪';
        root.appendChild(collectStatusEl);
        // 面板出现后自动拉一次收藏夹列表
        loadGroupsIntoPanel(false);
    }
    function ensureUI() {
        if (document.body) { initializeControls(); }
        else { setTimeout(ensureUI, 500); }
    }
    setInterval(function () {
        if (!document.body) return;
        var existing = document.getElementById('nox-script-ui');
        if (!existing) { initializeControls(); return; }
        var want = currentPageType();
        if (existing.getAttribute('data-page') !== want && !isScriptRunning) {
            existing.remove();
            initializeControls();
        }
    }, 1500);
    ensureUI();
})();
