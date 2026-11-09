// =========================================================================
// main.js - 主程序 / 事件协调器 (增强版: 增加 GitHub 自动登录与同步初始化)
// =========================================================================

import {
    state,
    getProxyMode,
    setProxyMode,
    loadAllDataSources,
    loadSearchConfig,
    performDataSourceSwitch,
    saveNavData,
    findSiteById,
    DEFAULT_SITES_PATH,
    NAV_DATA_SOURCE_PREFERENCE_KEY,
    CUSTOM_CATEGORY_ID,
    initGitHub,         // 新增
    syncFromGitHub,     // 新增
    GITHUB_TOKEN_KEY    // 新增
} from './dataManager.js';

import {
    dom,
    applyTheme,
    applyProxyMode,
    populateDataSourceSelector,
    renderNavPage,
    updateDeleteButtonState,
    showAlert,
    openSiteModal,
    closeSiteModal,
    closeImportNameModal,
    toggleEditMode,
    toggleDeleteMode,
    filterNavCards,
    renderSearchCategories,
    renderEngineCheckboxes,
    renderSuggestions,
    renderBookmarkSuggestions,
    showConfirm,
    toggleMobileSidebar,
    closeMobileSidebar,
    isolateSidebarScroll,
    initGithubUI,               // 新增
    updateGithubStatusIndicator // 新增
} from './ui.js';

import { handleExport, handleImportClick, handleFileSelect, handleImportNameSubmit, handleDeleteSource } from './fileManager.js';

let currentSearchCategory = '';
let suggestions = [];
let suggestionTimer = null;
let bookmarkMatches = [];
let bookmarkIndex = -1;

// =========================================================================
// #region 初始化与事件绑定
// =========================================================================

async function init() {
    // 0. URL Token 解析 (处理 GitHub 自动登录)
    // 允许通过 URL hash 传递 token: /#token=ghp_xxxx
    const hash = window.location.hash;
    if (hash && hash.includes('token=')) {
        try {
            const params = new URLSearchParams(hash.substring(1)); // 去掉 #
            const token = params.get('token');
            if (token) {
                localStorage.setItem(GITHUB_TOKEN_KEY, token);
                // 清除 URL 中的 Token，保护隐私
                history.replaceState(null, null, window.location.pathname);
                console.log("[Main] 检测到 URL Token，已自动保存");
            }
        } catch (e) {
            console.error("Token 解析失败", e);
        }
    }

    // 1. 初始化偏好 (主题 + 代理模式)
    applyTheme();
    applyProxyMode(getProxyMode());

    // 2. 初始化 GitHub 状态与 UI
    const githubReady = initGitHub();

    // 3. 加载本地数据源
    loadAllDataSources();
    setupStaticEventListeners();
    setupDynamicEventListeners();

    const lastUsedSource = localStorage.getItem(NAV_DATA_SOURCE_PREFERENCE_KEY) || DEFAULT_SITES_PATH;
    populateDataSourceSelector();

    // 4. 加载页面数据 (优先加载本地，随后尝试云同步)
    await Promise.all([
        performDataSourceSwitch(lastUsedSource, true, onDataSourceSwitchSuccess, onDataSourceSwitchFail),
        loadSearchConfig()
    ]);

    initEnhancedSearch();
    initGithubUI();
    const isGithubLoggedIn = await githubReady;
    if (isGithubLoggedIn) {
        updateGithubStatusIndicator('idle');
        dom.githubBtn?.classList.add('active');
    }

    // 5. 如果已登录 GitHub，触发后台静默同步
    if (isGithubLoggedIn) {
        // 延迟执行，不阻塞首屏交互
        setTimeout(() => {
            syncFromGitHub((status) => {
                updateGithubStatusIndicator(status);
                if (status === 'success') {
                    loadAllDataSources();
                    populateDataSourceSelector();
                    // 同步成功后，应用偏好设置并重新渲染当前页面
                    const proxyMode = getProxyMode();
                    applyTheme();
                    applyProxyMode(proxyMode);

                    const currentSource = dom.customSelect.dataset.value;
                    performDataSourceSwitch(currentSource, false, () => {
                        renderNavPage();
                        renderEngineCheckboxes(currentSearchCategory); // 确保搜索建议的代理状态也更新
                        console.log("[Main] 云端数据已应用");
                    });
                }
            });
        }, 1000);
    }
}

function setupStaticEventListeners() {
    const addressForm = document.getElementById('address-form');
    const addressInput = document.getElementById('address-input');
    const sanitizeAddress = value => value.replace(/[^A-Za-z0-9:/?#[\]@!$&'()*+,;=%._~-]/g, '');
    addressInput?.addEventListener('input', () => {
        const sanitized = sanitizeAddress(addressInput.value);
        if (sanitized !== addressInput.value) addressInput.value = sanitized;
    });
    addressForm?.addEventListener('submit', event => {
        event.preventDefault();
        const value = sanitizeAddress(addressInput.value).trim();
        addressInput.value = value;
        if (!value || /\s/.test(value)) return;

        try {
            const address = /^(https?):\/\//i.test(value) ? value : `https://${value}`;
            const url = new URL(address);
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return;
            window.open(url.href, '_blank', 'noopener');
        } catch {
            addressInput.focus();
        }
    });

    // 移动端菜单控制
    if (dom.mobileMenuBtn) {
        dom.mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMobileSidebar();
        });
    }
    if (dom.sidebarOverlay) {
        dom.sidebarOverlay.addEventListener('click', closeMobileSidebar);
    }

    // 侧边栏滚动隔离
    isolateSidebarScroll();

    // 代理模式切换
    if (dom.proxyModeSwitch) {
        dom.proxyModeSwitch.addEventListener('change', () => {
            const isChecked = dom.proxyModeSwitch.checked;
            applyProxyMode(isChecked);
            setProxyMode(isChecked);
            renderEngineCheckboxes(currentSearchCategory);
            saveNavData(dom.customSelect.dataset.value);
        });
    }

    // 自定义数据源选择器
    dom.customSelectTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.customSelect.classList.toggle('open');
    });

    dom.customSelectOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.custom-select-option');
        if (option) {
            e.stopPropagation();
            const newValue = option.dataset.value;
            if (newValue !== dom.customSelect.dataset.value) {
                handleDataSourceChange(newValue);
            }
            dom.customSelect.classList.remove('open');
        }
    });

    document.addEventListener('click', (e) => {
        if (!dom.customSelect.contains(e.target)) {
            dom.customSelect.classList.remove('open');
        }
    });

    // 导入导出与数据源管理
    dom.exportBtn.addEventListener('click', handleExport);
    dom.importBtn.addEventListener('click', handleImportClick);
    dom.deleteSourceBtn.addEventListener('click', handleDeleteSource);
    dom.importFileInput.addEventListener('change', handleFileSelect);
    dom.importNameForm.addEventListener('submit', handleImportNameSubmit);
    dom.cancelImportNameBtn.addEventListener('click', closeImportNameModal);
    dom.importNameModal.addEventListener('click', e => {
        if (e.target === dom.importNameModal) closeImportNameModal();
    });

    if (dom.importModeNewRadio && dom.importModeMergeRadio) {
        dom.importModeNewRadio.addEventListener('change', () => {
            dom.importNameInput.disabled = false;
        });
        dom.importModeMergeRadio.addEventListener('change', () => {
            dom.importNameInput.disabled = true;
        });
    }

    // 网站编辑模态框
    dom.siteForm.addEventListener('submit', handleSiteFormSubmit);
    dom.cancelBtn.addEventListener('click', closeSiteModal);
    dom.siteModal.addEventListener('click', e => {
        if (e.target === dom.siteModal) closeSiteModal();
    });

    // 自动填充图标URL
    dom.siteUrlInput.addEventListener('blur', e => {
        if (dom.siteIconInput.value || !e.target.value) return;
        try {
            const url = new URL(e.target.value);
            dom.siteIconInput.value = `${url.origin}/favicon.ico`;
        } catch (error) {}
    });
}

function setupDynamicEventListeners() {
    dom.contentWrapper.addEventListener('click', e => {
        const addSiteBtn = e.target.closest('.add-site-btn');
        const editSiteBtn = e.target.closest('.edit-site-btn');
        const deleteSiteBtn = e.target.closest('.delete-site-btn');
        const clearCategoryBtn = e.target.closest('.clear-category-btn');
        const card = e.target.closest('.card');

        if (addSiteBtn) {
            const categoryId = addSiteBtn.dataset.categoryId;
            const categoryName = addSiteBtn.dataset.categoryName;
            openSiteModal('add', null, categoryId, categoryName);
            return;
        }

        if (editSiteBtn) {
            toggleEditMode();
            return;
        }

        if (deleteSiteBtn) {
            toggleDeleteMode();
            return;
        }

        if (clearCategoryBtn) {
            const categoryId = clearCategoryBtn.dataset.categoryId;
            const categoryName = clearCategoryBtn.dataset.categoryName;
            handleClearCategory(categoryId, categoryName);
            return;
        }

        if (card) {
            e.preventDefault();
            const isInEditMode = dom.contentWrapper.classList.contains('is-editing');
            const isInDeleteMode = dom.contentWrapper.classList.contains('is-deleting');
            const isEditable = card.closest('.custom-source-section');

            if (isInDeleteMode && isEditable) {
                handleCardDelete(card);
            } else if (isInEditMode && isEditable) {
                const { site, category } = findSiteById(card.dataset.id);
                if (site && category) {
                    openSiteModal('edit', site, category.categoryId, category.categoryName);
                }
            } else {
                window.open(card.dataset.url, '_blank');
            }
        }
    });

    // --- 拖拽排序逻辑 ---
    let draggedItem = null, placeholder = null;

    dom.contentWrapper.addEventListener('dragstart', e => {
        const card = e.target.closest('.card');
        if (card && card.draggable) {
            draggedItem = card;
            placeholder = document.createElement('div');
            placeholder.className = 'placeholder';
            placeholder.style.height = `${draggedItem.offsetHeight}px`;
            setTimeout(() => draggedItem.classList.add('dragging'), 0);
        }
    });

    dom.contentWrapper.addEventListener('dragover', e => {
        e.preventDefault();
        if (!draggedItem) return;
        const overCard = e.target.closest('.card:not(.dragging)');
        const overGrid = e.target.closest('.card-grid');
        const overSection = e.target.closest('.custom-source-section');

        if (overSection) {
            if (overCard) {
                const rect = overCard.getBoundingClientRect();
                const midpointY = rect.top + rect.height / 2;
                const midpointX = rect.left + rect.width / 2;
                const isAfter = (e.clientY > midpointY) || (e.clientX > midpointX && Math.abs(e.clientY - midpointY) < 50);
                overCard.parentNode.insertBefore(placeholder, isAfter ? overCard.nextSibling : overCard);
            } else if (overGrid && !overGrid.querySelector('.placeholder')) {
                overGrid.appendChild(placeholder);
            }
        }
    });

    dom.contentWrapper.addEventListener('drop', e => {
        e.preventDefault();
        if (!draggedItem || !placeholder || !placeholder.parentNode) return;

        const draggedSiteId = draggedItem.dataset.id;
        const { site: draggedSite, category: sourceCategory } = findSiteById(draggedSiteId);
        const targetSection = placeholder.closest('.custom-source-section');

        if (!draggedSite || !sourceCategory || !targetSection) return;

        const targetCategoryId = targetSection.id;
        const targetCategory = state.siteData.categories.find(c => c.categoryId === targetCategoryId);

        if (!targetCategory) return;

        placeholder.parentNode.replaceChild(draggedItem, placeholder);

        const sourceSites = sourceCategory.sites;
        const siteIndex = sourceSites.findIndex(s => s.id === draggedSiteId);
        if (siteIndex > -1) sourceSites.splice(siteIndex, 1);

        const newOrderedIds = Array.from(targetSection.querySelectorAll('.card')).map(c => c.dataset.id);

        if (sourceCategory.categoryId !== targetCategory.categoryId) {
            targetCategory.sites.push(draggedSite);
        }

        targetCategory.sites.sort((a, b) => newOrderedIds.indexOf(a.id) - newOrderedIds.indexOf(b.id));

        if (sourceCategory.sites.length === 0 && sourceCategory.categoryId !== CUSTOM_CATEGORY_ID) {
            state.siteData.categories = state.siteData.categories.filter(c => c.categoryId !== sourceCategory.categoryId);
            renderNavPage();
        }

        saveNavData(dom.customSelect.dataset.value);
    });

    dom.contentWrapper.addEventListener('dragend', () => {
        if (draggedItem) draggedItem.classList.remove('dragging');
        if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        draggedItem = null;
        placeholder = null;
    });
}

// =========================================================================
// #region 事件处理器
// =========================================================================

function handleDataSourceChange(newIdentifier) {
    const option = dom.customSelectOptions.querySelector(`[data-value="${newIdentifier}"]`);
    if (option) {
        dom.customSelectSelectedText.textContent = option.textContent;
        dom.customSelect.dataset.value = newIdentifier;
        const oldSelected = dom.customSelectOptions.querySelector('.selected');
        if (oldSelected) oldSelected.classList.remove('selected');
        option.classList.add('selected');
    }
    performDataSourceSwitch(newIdentifier, false, onDataSourceSwitchSuccess, onDataSourceSwitchFail);
}

function onDataSourceSwitchSuccess() {
    renderNavPage();
    dom.searchInput.value = '';
    filterNavCards('');
    updateDeleteButtonState();
    if (window.innerWidth <= 768) closeMobileSidebar();
}

function onDataSourceSwitchFail(sourceName, error) {
    showAlert(`加载数据源失败: ${sourceName}\n${error.message}`, '加载错误');
    localStorage.setItem(NAV_DATA_SOURCE_PREFERENCE_KEY, state.originalDataSourceValue);
    populateDataSourceSelector();
}

async function handleSiteFormSubmit(e) {
    e.preventDefault();
    const wasInEditMode = dom.contentWrapper.classList.contains('is-editing');
    const wasInDeleteMode = dom.contentWrapper.classList.contains('is-deleting');

    const siteId = dom.siteIdInput.value;
    const targetCategoryId = dom.categoryIdInput.value;

    const sitePayload = {
        id: siteId || `site-${Date.now()}-${Math.random()}`,
        url: dom.siteUrlInput.value,
        title: dom.siteTitleInput.value,
        icon: dom.siteIconInput.value,
        desc: dom.siteDescInput.value,
        proxy: dom.siteProxyInput.checked
    };

    let targetCategory = state.siteData.categories.find(c => c.categoryId === targetCategoryId);

    if (siteId) {
        const { site } = findSiteById(siteId);
        if (site) {
            Object.assign(site, sitePayload);
        } else {
            if (targetCategory) targetCategory.sites.unshift(sitePayload);
        }
    } else {
        if (targetCategory) {
            targetCategory.sites.unshift(sitePayload);
        } else {
            showAlert(`操作失败：找不到目标分类 (ID: ${targetCategoryId})`, '错误');
            closeSiteModal();
            return;
        }
    }

    saveNavData(dom.customSelect.dataset.value);

    dom.contentWrapper.classList.remove('is-editing', 'is-deleting');
    renderNavPage();
    closeSiteModal();

    if (wasInEditMode) toggleEditMode();
    if (wasInDeleteMode) toggleDeleteMode();
    filterNavCards(dom.searchInput.value);
}

async function handleCardDelete(cardElement) {
    const siteId = cardElement.dataset.id;
    const { site, category } = findSiteById(siteId);

    if (!site || !category) return;

    const confirmed = await showConfirm(`确定要删除网站 "${site.title}" 吗?`, "删除确认");
    if (!confirmed) return;

    category.sites = category.sites.filter(s => s.id !== siteId);

    if (category.sites.length === 0 && category.categoryId !== CUSTOM_CATEGORY_ID) {
        state.siteData.categories = state.siteData.categories.filter(c => c.categoryId !== category.categoryId);
        if (state.siteData.categories.length === 0) {
            state.siteData.categories.push({
                categoryName: '我的导航',
                categoryId: CUSTOM_CATEGORY_ID,
                sites: []
            });
        }
        renderNavPage();
    } else {
        cardElement.remove();
    }

    saveNavData(dom.customSelect.dataset.value);
}

async function handleClearCategory(categoryId, categoryName) {
    if (!categoryId || !categoryName) return;
    const confirmed = await showConfirm(`确定要清空分类 "${categoryName}" 下的所有书签吗？\n此操作不可撤销。`, "清空确认");
    if (!confirmed) return;
    const category = state.siteData.categories.find(c => c.categoryId === categoryId);
    if (category) {
        category.sites = [];
        saveNavData(dom.customSelect.dataset.value);
        renderNavPage();
        showAlert(`分类 "${categoryName}" 已被清空。`, '操作成功');
    } else {
        showAlert(`操作失败：找不到分类 (ID: ${categoryId})`, '错误');
    }
}

// =========================================================================
// #region 增强搜索逻辑
// =========================================================================

function initEnhancedSearch() {
    renderSearchCategories();
    if (state.searchConfig.categories.length > 0) {
        selectSearchCategory(state.searchConfig.categories[0].value);
    }
    dom.searchForm.addEventListener('submit', handleSearchSubmit);
    dom.searchInput.addEventListener('input', handleSuggestionInput);

    dom.searchInput.addEventListener('focus', () => {
        dom.searchForm.classList.add('focused');
        document.body.classList.add('search-focused');
    });
    dom.searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            dom.searchForm.classList.remove('focused');
            document.body.classList.remove('search-focused');
        }, 200);
    });

    dom.suggestionsList.addEventListener('mouseleave', startSuggestionTimer);
    dom.suggestionsList.addEventListener('mouseenter', clearSuggestionTimer);
    document.addEventListener('click', e => {
        if (!dom.searchForm.contains(e.target) && !dom.suggestionsList.contains(e.target)) {
            suggestions = [];
            renderSuggestions(suggestions);
        }
    });
    window.addEventListener('keydown', e => {
        if (document.activeElement === dom.searchInput && bookmarkMatches.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            bookmarkIndex = (bookmarkIndex + (e.key === 'ArrowDown' ? 1 : -1) + bookmarkMatches.length) % bookmarkMatches.length;
            renderBookmarkSuggestions(bookmarkMatches, bookmarkIndex);
            return;
        }
        if (e.key === 'Escape') {
            suggestions = [];
            renderSuggestions(suggestions);
            dom.searchInput.blur();
        }
    });
    dom.searchCategoryButtonsContainer.addEventListener('click', e => {
        if (e.target.tagName === 'BUTTON') {
            selectSearchCategory(e.target.dataset.value);
        }
    });
}

function selectSearchCategory(categoryValue) {
    currentSearchCategory = categoryValue;
    const buttons = dom.searchCategoryButtonsContainer.querySelectorAll('.category-btn');
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.value === categoryValue));
    renderEngineCheckboxes(currentSearchCategory);
}

function handleSearchSubmit(e) {
    e.preventDefault();
    const query = dom.searchInput.value.trim();
    if (bookmarkMatches.length && bookmarkIndex >= 0) {
        window.open(bookmarkMatches[bookmarkIndex].url, '_blank', 'noopener');
        bookmarkMatches = []; bookmarkIndex = -1; renderSuggestions([]); return;
    }
    const checkedEngines = dom.searchEngineCheckboxesContainer.querySelectorAll('input[type="checkbox"]:checked');

    if (query === '' && checkedEngines.length > 0) {
        const firstEngineUrl = new URL(checkedEngines[0].value.replace('%s', ''));
        window.open(firstEngineUrl.origin, "_blank");
        return;
    }
    if (checkedEngines.length === 0) {
        showAlert('请至少选择一个搜索引擎！');
        return;
    }
    checkedEngines.forEach(engineCheckbox => {
        const searchUrl = engineCheckbox.value.replaceAll('%s', encodeURIComponent(query));
        window.open(searchUrl, '_blank');
    });
    suggestions = [];
    renderSuggestions(suggestions);
    dom.searchInput.blur();
}

function handleSuggestionInput() {
    const query = dom.searchInput.value.trim();
    filterNavCards(query);
    bookmarkIndex = -1;
    bookmarkMatches = query ? state.siteData.categories.flatMap(category => category.sites).filter(site => `${site.title} ${site.url} ${site.desc || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 7) : [];
    if (bookmarkMatches.length) {
        renderBookmarkSuggestions(bookmarkMatches);
        return;
    }
    if (query !== '') {
        const script = document.createElement('script');
        script.src = `https://suggestion.baidu.com/su?wd=${encodeURIComponent(query)}&cb=window.baidu.sug`;
        document.body.appendChild(script);
        script.onload = () => document.body.removeChild(script);
        script.onerror = () => document.body.removeChild(script);
    } else {
        suggestions = [];
        renderSuggestions(suggestions);
    }
    clearSuggestionTimer();
    startSuggestionTimer();
}

window.baidu = {
    sug: data => {
        suggestions = (data && Array.isArray(data.s)) ? data.s : [];
        renderSuggestions(suggestions);
        dom.suggestionsList.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                dom.searchInput.value = item.textContent;
                suggestions = [];
                renderSuggestions(suggestions);
                dom.searchInput.focus();
                filterNavCards(dom.searchInput.value);
            });
        });
    }
};

function startSuggestionTimer() {
    clearSuggestionTimer();
    suggestionTimer = setTimeout(() => {
        suggestions = [];
        renderSuggestions(suggestions);
    }, 3000);
}

function clearSuggestionTimer() {
    clearTimeout(suggestionTimer);
}

// === 启动应用 ===
document.addEventListener('DOMContentLoaded', init);
