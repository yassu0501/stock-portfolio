/* ===================================================================
   script.js — 株式ポートフォリオダッシュボード ロジック
   
   Firebase (Auth/Firestore) による認証と同期。
   株価は Yahoo Finance API（CORSプロキシ経由）から取得。
   =================================================================== */

// Firebase 設定
const firebaseConfig = {
  apiKey: "AIzaSyDdSN0EEHvC8EgKEuFCwSdpr8j7ObUfhII",
  authDomain: "my-stock-portfolio-5b3e5.firebaseapp.com",
  projectId: "my-stock-portfolio-5b3e5",
  storageBucket: "my-stock-portfolio-5b3e5.firebasestorage.app",
  messagingSenderId: "235967633340",
  appId: "1:235967633340:web:b69877e8174a434ea43db9"
};

// Firebase 初期化
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/** 現在のログインユーザー */
let currentUser = null;

/** データ読み込み中フラグ（保存処理のガードに使用） */
let isDataLoading = false;

/** 認証初期化済みフラグ */
let isAuthInitialized = false;

// =========================================================
// グローバル変数
// =========================================================

/** ポートフォリオデータ配列 */
let portfolio = [];

/** 資産推移の履歴データ */
let portfolioHistory = [];

/** 確定済みの実現損益（合計） */
let realizedPnl = 0;

/** 確定実現損益の詳細履歴 */
let realizedHistory = [];

/** 円グラフ（Chart.jsインスタンス） */
let pieChartInstance = null;

/** 資産推移グラフ（Chart.jsインスタンス） */
let historyChartInstance = null;

/** 株価自動更新のタイマーID */
let priceUpdateTimer = null;

/** 複数回更新が同時に走るのを防ぐフラグ */
let isUpdatingPrices = false;

/** Google Apps Script (GAS) 経由で取得する専用URL */
const GAS_PROXY_URL = 'https://script.google.com/macros/s/AKfycbwaFVLgBtTXzLI39qkcO7VfBL3mkdbGBNlI0Stc1wJjuiF-4GXbUXX6WzdcVBoOzJ65PA/exec';

/** GAS経由でデータを取得する関数 */
async function fetchWithProxy(ticker) {
  try {
    // GASには ?ticker=SYMBOL の形式で渡す
    const url = `${GAS_PROXY_URL}?ticker=${encodeURIComponent(ticker)}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`GAS returned status ${response.status}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    return data;
  } catch (e) {
    console.error(`GAS fetch error:`, e.message);
    throw e;
  }
}

// =========================================================
// 初期化
// =========================================================

/**
 * ページ読み込み時に実行される初期化関数
 */
document.addEventListener('DOMContentLoaded', async () => {
  // 認証状態の監視
  auth.onAuthStateChanged(async (user) => {
    // ユーザーが切り替わった場合、または初回読み込み時
    const userChanged = !isAuthInitialized || (currentUser?.uid !== user?.uid);
    currentUser = user;
    isAuthInitialized = true;
    updateAuthUI();

    if (userChanged) {
      isDataLoading = true;
      // データを一度リセット（古いユーザーやゲストのデータが残らないようにする）
      portfolio = [];
      portfolioHistory = [];
      realizedHistory = [];

      if (user) {
        // ログイン時はFirestoreから取得
        await loadFromFirestore();
      } else {
        // 未ログイン時はLocalStorageから取得
        await loadPortfolio();
      }
      isDataLoading = false;

      // 画面を共通で描画 (株価更新も含む)
      refreshUI();
    }
  });

  // 購入日のデフォルト値を今日に設定
  const dateInput = document.getElementById('input-date');
  if (dateInput) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }

  // 初回の株価更新などは onAuthStateChanged 側に任せるため、ここでは行わない（二重実行防止）

  // 5分ごとに株価を自動更新（300,000ms = 5分）
  priceUpdateTimer = setInterval(() => {
    if (portfolio.length > 0) {
      updatePrices();
    }
  }, 300000);

  // 銘柄コード入力時に自動で銘柄名を取得するイベントリスナー
  const tickerInput = document.getElementById('input-ticker');
  const nameInput = document.getElementById('input-name');
  if (tickerInput && nameInput) {
    tickerInput.addEventListener('blur', async (e) => {
      let ticker = e.target.value.trim().toUpperCase();
      if (!ticker) return;
      
      // 日本の4桁銘柄コード（英字含む）が入力された場合、自動で .T を付与する
      // ※JPXの新銘柄コード規則：1桁目と3桁目は数字、2桁目または4桁目が英字になり得る（例: 285A）
      if (/^[0-9][0-9A-Z][0-9][0-9A-Z]$/.test(ticker)) {
        ticker += '.T';
        tickerInput.value = ticker; // フィールドの表示も更新
      }
      
      // すでに名前が入力されている場合は上書きしない（ユーザーの入力を尊重）
      if (nameInput.value.trim() !== '') return;

      // まずローカルの日本語銘柄名リストから探す
      if (typeof stockNames !== 'undefined' && stockNames[ticker]) {
        nameInput.value = stockNames[ticker];
        return;
      }

      try {
        // Yahoo Finance APIから情報を取得 (ローカルリストにない場合のフォールバック)
        // fetchWithProxy にはティッカー（285A.Tなど）を直接渡す
        const data = await fetchWithProxy(ticker);
        const meta = data?.chart?.result?.[0]?.meta;
        // 日本株の場合は shortName が無い場合が多いので、longName 等も確認、ダメならティッカーそのまま
        const fetchedName = meta?.shortName || meta?.longName || meta?.symbol;
        if (fetchedName) {
          nameInput.value = fetchedName;
        }
      } catch (err) {
        console.warn('銘柄名の自動取得に失敗しました', err);
      }
    });
  }
});

/**
 * 画面全体の描画をリフレッシュする
 */
function refreshUI() {
  renderPortfolio();
  calculateSummary();
  renderPieChart();
  renderHistoryChart();
  
  if (portfolio.length > 0) {
    updatePrices();
  }
}

/**
 * 認証UIの更新
 */
function updateAuthUI() {
  const loggedOutView = document.getElementById('auth-logged-out');
  const loggedInView = document.getElementById('auth-logged-in');
  const userNameEl = document.getElementById('user-name');

  if (currentUser) {
    loggedOutView.style.display = 'none';
    loggedInView.style.display = 'flex';
    userNameEl.textContent = `${currentUser.displayName} さん`;
  } else {
    loggedOutView.style.display = 'block';
    loggedInView.style.display = 'none';
  }
}

/**
 * Googleログイン
 */
async function loginWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    // ポップアップの代わりにリダイレクトを使用（GitHub Pagesでの安定性向上）
    await auth.signInWithRedirect(provider);
  } catch (error) {
    console.error('Login error:', error);
    showToast(`ログイン処理の開始に失敗しました (${error.message})`, 'error');
  }
}

/**
 * ログアウト
 */
async function logout() {
  try {
    await auth.signOut();
    showToast('ログアウトしました', 'info');
    // ログアウト時はLocalStorageの状態に切り替わる
  } catch (error) {
    showToast('ログアウトに失敗しました', 'error');
  }
}

/**
 * データを保存する（Auth状態に応じて振分）
 */
async function savePortfolio() {
  // 読み込み中や初期化前は保存をスキップ（データの先祖返りを防ぐ）
  if (isDataLoading || !isAuthInitialized) return;

  // LocalStorageへの保存（バックアップ的に実行）
  try {
    localStorage.setItem('portfolio', JSON.stringify(portfolio));
    localStorage.setItem('lifetimePnlHistory', JSON.stringify(portfolioHistory));
    localStorage.setItem('realizedHistory', JSON.stringify(realizedHistory));
  } catch (e) {
    console.error('LocalStorage save error:', e);
  }

  // Firestoreへの保存
  if (currentUser) {
    try {
      await db.collection('users').doc(currentUser.uid).set({
        portfolio,
        portfolioHistory,
        realizedHistory,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.error('Firestore save error:', e);
      showToast('クラウドへの保存に失敗しました', 'error');
    }
  }
}

/**
 * Firestoreから読み込む
 */
async function loadFromFirestore() {
  if (!currentUser) return;
  const wasLoading = isDataLoading;
  isDataLoading = true;
  showToast('クラウドからデータを読み込んでいます...', 'info');

  try {
    // 為替レート取得は不要のため削除

    const doc = await db.collection('users').doc(currentUser.uid).get();
    if (doc.exists) {
      const data = doc.data();
      portfolio = data.portfolio || [];
      portfolioHistory = data.portfolioHistory || [];
      realizedHistory = data.realizedHistory || [];
    } else {
      // 初回ログイン時は既存のLocalStorageデータを移行するか確認
      const localData = localStorage.getItem('portfolio');
      if (localData && confirm('ブラウザに保存されているデータをクラウドに同期しますか？')) {
        await loadPortfolio(); // Localから読み込み
        await savePortfolio();   // クラウドに保存
      } else {
        portfolio = [];
        portfolioHistory = [];
        realizedHistory = [];
      }
    }
  } catch (e) {
    console.error('Firestore load error:', e);
    showToast('クラウドからの読み込みに失敗しました', 'error');
  } finally {
    if (!wasLoading) isDataLoading = false;
  }
}

/**
 * LocalStorageからポートフォリオと履歴を読み込む
 */
async function loadPortfolio() {
  const wasLoading = isDataLoading;
  isDataLoading = true;
  try {
    const savedPortfolio = localStorage.getItem('portfolio');
    const savedHistory = localStorage.getItem('lifetimePnlHistory');
    const savedRealizedHistory = localStorage.getItem('realizedHistory');

    // 為替レート取得は不要のため削除

    // ポートフォリオデータの復元
    if (savedPortfolio) {
      portfolio = JSON.parse(savedPortfolio);
      // 既存データの正規化（285A -> 285A.T など）
      portfolio.forEach(stock => {
        if (stock.ticker && /^[0-9][0-9A-Z][0-9][0-9A-Z]$/.test(stock.ticker.toUpperCase())) {
          stock.ticker = stock.ticker.toUpperCase() + '.T';
        }
      });
    }

    // 履歴データの復元
    if (savedHistory) {
      portfolioHistory = JSON.parse(savedHistory);
    }

    // 実現損益履歴の復元
    if (savedRealizedHistory) {
      realizedHistory = JSON.parse(savedRealizedHistory);
    } else {
      // 互換性維持: 以前のrealizedPnlがある場合はダミー履歴を作成
      const savedRealizedPnl = localStorage.getItem('realizedPnl');
      if (savedRealizedPnl) {
        realizedPnl = parseFloat(savedRealizedPnl);
        if (realizedPnl !== 0) {
          realizedHistory = [{
            id: Date.now(),
            name: '過去の確定損益',
            ticker: 'OLD',
            buyPrice: 0,
            sellPrice: realizedPnl,
            shares: 1,
            date: new Date().toISOString().split('T')[0]
          }];
        }
      }
    }
  } catch (e) {
    console.error('LocalStorageからの読み込みに失敗しました:', e);
    portfolio = [];
    portfolioHistory = [];
    realizedHistory = [];
  } finally {
    if (!wasLoading) isDataLoading = false;
  }
}

// =========================================================
// 株式追加・削除
// =========================================================

/**
 * フォームの入力値からポートフォリオに銘柄を追加する
 */
async function addStock() {
  // フォームから値を取得
  const nameInput = document.getElementById('input-name');
  const tickerInput = document.getElementById('input-ticker');
  const priceInput = document.getElementById('input-price');
  const sharesInput = document.getElementById('input-shares');
  const dateInput = document.getElementById('input-date');

  const name = nameInput.value.trim();
  let ticker = tickerInput.value.trim().toUpperCase();
  
  // 日本の4桁銘柄コード（英字含む）が入力された場合、自動で .T を付与する
  if (/^[0-9][0-9A-Z][0-9][0-9A-Z]$/.test(ticker)) {
    ticker += '.T';
  }

  const buyPrice = parseFloat(priceInput.value);
  const shares = parseInt(sharesInput.value, 10);
  const date = dateInput.value;

  // バリデーション
  if (!name || !ticker || isNaN(buyPrice) || isNaN(shares) || !date) {
    showToast('すべての項目を正しく入力してください', 'error');
    return;
  }

  if (buyPrice <= 0) {
    showToast('購入価格は0より大きい値を入力してください', 'error');
    return;
  }

  if (shares <= 0) {
    showToast('株数は1以上を入力してください', 'error');
    return;
  }

  // 同一銘柄がすでにポートフォリオにあるか確認
  const existingStockIndex = portfolio.findIndex(s => s.ticker === ticker);

  if (existingStockIndex !== -1) {
    // 既存銘柄がある場合は平均取得単価を計算して更新
    const existingStock = portfolio[existingStockIndex];
    const totalShares = existingStock.shares + shares;
    // 平均取得単価 = (既存の総取得額 + 今回の取得額) / 合計株数
    const newAveragePrice = ((existingStock.buyPrice * existingStock.shares) + (buyPrice * shares)) / totalShares;
    
    existingStock.shares = totalShares;
    existingStock.buyPrice = newAveragePrice;
    // 購入日は最新の追加日に更新、またはそのまま（ここでは最新に更新）
    existingStock.date = date;
    
    showToast(`${name}（${ticker}）を買い増ししました（平均単価: ¥${formatNumber(newAveragePrice)}）`, 'success');
  } else {
    // 新規銘柄として追加
    const newStock = {
      name: name,
      ticker: ticker,
      buyPrice: buyPrice,
      shares: shares,
      date: date,
      currentPrice: null
    };
    portfolio.push(newStock);
    showToast(`${name}（${ticker}）を追加しました`, 'success');
  }

  // 保存と画面更新
  savePortfolio();
  renderPortfolio();
  calculateSummary();
  renderPieChart();

  // フォームをクリア
  nameInput.value = '';
  tickerInput.value = '';
  priceInput.value = '';
  sharesInput.value = '';
  dateInput.value = new Date().toISOString().split('T')[0];

  // 全銘柄の価格を更新（または該当銘柄のみでも良いが、確実なのは全体）
  updatePrices();
}

/**
 * 指定インデックスの銘柄をポートフォリオから削除する
 * @param {number} index - 削除する銘柄のインデックス
 */
function deleteStock(index) {
  const stock = portfolio[index];
  if (!stock) return;

  // 配列から削除
  portfolio.splice(index, 1);

  // 保存と画面更新
  savePortfolio();
  renderPortfolio();
  calculateSummary();
  renderPieChart();
  savePortfolioHistory();
  renderHistoryChart();

  showToast(`${stock.name} を削除しました`, 'info');
}

// =========================================================
// ポートフォリオテーブル描画
// =========================================================

/**
 * ポートフォリオ一覧テーブルを描画する
 */
function renderPortfolio() {
  const tbody = document.getElementById('portfolio-tbody');
  const table = document.getElementById('portfolio-table');
  const emptyMsg = document.getElementById('empty-message');

  // テーブル内容をクリア
  tbody.innerHTML = '';

  // 銘柄がない場合の表示切り替え
  if (portfolio.length === 0) {
    table.classList.add('hidden');
    emptyMsg.classList.add('visible');
    return;
  }

  table.classList.remove('hidden');
  emptyMsg.classList.remove('visible');

  // 各銘柄の行を生成
  portfolio.forEach((stock, index) => {
    const tr = document.createElement('tr');

    // 入力された購入価格はすでに円の前提
    const buyPriceJpy = stock.buyPrice;
    const currentPriceJpy = stock.currentPrice !== null ? convertToJpy(stock.currentPrice, stock.ticker) : null;

    // 現在価格の表示内容（取得エラーかどうかでフォールバック）
    let priceDisplay;
    if (currentPriceJpy !== null) {
      priceDisplay = '¥' + formatNumber(currentPriceJpy);
    } else if (stock.fetchFailed) {
      priceDisplay = '<span style="color: var(--accent-red); font-size: 0.9em;">取得エラー</span>';
    } else {
      priceDisplay = '<span class="loading-spinner"></span>';
    }

    // 評価額 = 現在価格 × 株数
    const marketValue = currentPriceJpy !== null ? currentPriceJpy * stock.shares : null;

    // 損益 = (現在価格 - 購入価格) × 株数
    const pnl = currentPriceJpy !== null ? (currentPriceJpy - buyPriceJpy) * stock.shares : null;

    // 損益の色クラス
    let pnlClass = '';
    if (pnl !== null) {
      pnlClass = pnl >= 0 ? 'profit' : 'loss';
    }

    // 損益率 = (現在価格 - 購入価格) / 購入価格
    const pnlPercent = currentPriceJpy !== null ? ((currentPriceJpy - buyPriceJpy) / buyPriceJpy) * 100 : null;

    tr.innerHTML = `
      <td data-label="銘柄名">${escapeHtml(stock.name)}</td>
      <td data-label="銘柄コード" class="ticker-cell">${escapeHtml(stock.ticker)}</td>
      <td data-label="購入価格">¥${formatNumber(buyPriceJpy)}</td>
      <td data-label="現在価格">${priceDisplay}</td>
      <td data-label="株数">${stock.shares.toLocaleString()}</td>
      <td data-label="評価額">${marketValue !== null ? '¥' + formatNumber(marketValue) : '—'}</td>
      <td data-label="損益" class="${pnlClass}">
        ${pnl !== null ? (pnl >= 0 ? '+' : '-') + '¥' + formatNumber(Math.abs(pnl)) : '—'}
        ${pnlPercent !== null ? `<div class="pnl-percent">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</div>` : ''}
      </td>
      <td>
        <div style="display: flex; flex-direction: column; gap: var(--space-xs); width: 100%;">
          <button class="btn btn--danger" onclick="window.deleteStock(${index})">削除</button>
          <button class="btn btn--secondary" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;" onclick="window.openSellModal(${index})">損益確定</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

// =========================================================
// サマリー計算
// =========================================================

/**
 * 総投資額・現在評価額・総損益を計算してカードに表示する
 */
function calculateSummary() {
  let totalInvestment = 0;  // 総投資額
  let totalCurrent = 0;     // 現在評価額
  let hasCurrentPrice = false;

  portfolio.forEach((stock) => {
    const buyPriceJpy = stock.buyPrice;
    const currentPriceJpy = stock.currentPrice !== null ? convertToJpy(stock.currentPrice, stock.ticker) : null;

    // 総投資額 = 購入価格 × 株数
    totalInvestment += buyPriceJpy * stock.shares;

    // 現在評価額 = 現在価格 × 株数
    if (currentPriceJpy !== null) {
      totalCurrent += currentPriceJpy * stock.shares;
      hasCurrentPrice = true;
    }
  });

  // 総損益 = 現在評価額 - 総投資額
  const totalPnl = hasCurrentPrice ? totalCurrent - totalInvestment : 0;
  const totalPnlPercent = totalInvestment > 0 ? (totalPnl / totalInvestment) * 100 : 0;

  // DOM要素を更新
  document.getElementById('total-investment').textContent = '¥' + formatNumber(totalInvestment);

  const currentEl = document.getElementById('total-current');
  currentEl.textContent = hasCurrentPrice ? '¥' + formatNumber(totalCurrent) : '—';

  const pnlEl = document.getElementById('total-pnl');
  pnlEl.textContent = hasCurrentPrice
    ? (totalPnl >= 0 ? '+¥' : '-¥') + formatNumber(Math.abs(totalPnl)) + ` (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%)`
    : '—';

  // 損益に応じた色を適用
  pnlEl.className = 'summary__value'; // クラスをリセット
  if (hasCurrentPrice) {
    pnlEl.style.color = totalPnl >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)';
    if (totalPnl >= 0) pnlEl.classList.add('profit'); else pnlEl.classList.add('loss');
  } else {
    pnlEl.style.color = '';
  }

  // 実現損益の更新（履歴配列から再計算）
  realizedPnl = realizedHistory.reduce((sum, item) => {
    // 現在は日本株メインのため、個別の為替換算は行わずそのまま合算
    // (将来的に海外株に対応する場合はここにレート取得ロジックが必要)
    return sum + (item.sellPrice - item.buyPrice) * item.shares;
  }, 0);

  const realizedEl = document.getElementById('realized-pnl');
  if (realizedEl) {
    realizedEl.textContent = (realizedPnl >= 0 ? '+¥' : '-¥') + formatNumber(Math.abs(realizedPnl));
    realizedEl.className = 'summary__value'; // クラスをリセット
    realizedEl.style.color = realizedPnl >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)';
    if (realizedPnl >= 0) realizedEl.classList.add('profit'); else realizedEl.classList.add('loss');
  }

  // 生涯損益（数字表示）の更新
  const lifetimePnl = totalPnl + realizedPnl;
  const lifetimeEl = document.getElementById('lifetime-pnl-display');
  if (lifetimeEl) {
    lifetimeEl.textContent = (lifetimePnl >= 0 ? '+¥' : '-¥') + formatNumber(Math.abs(lifetimePnl));
    lifetimeEl.style.color = lifetimePnl >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)';
    // 生涯損益の大きな文字にも光彩（Glow）効果を適用
    if (lifetimePnl >= 0) {
      lifetimeEl.style.textShadow = '0 0 20px rgba(16, 185, 129, 0.4)';
    } else {
      lifetimeEl.style.textShadow = '0 0 20px rgba(244, 63, 94, 0.4)';
    }
  }
}

// =========================================================
// 株価API連携（Yahoo Finance — APIキー不要）
// =========================================================

/**
 * 通貨換算（現在は日本株のみ・または価格をそのまま扱うため、変換せずに返す）
 */
function convertToJpy(price, ticker) {
  return price || 0;
}

/**
 * 指定インデックスの銘柄の株価を取得する
 */
async function fetchStockPrice(index) {
  const stock = portfolio[index];
  if (!stock) return;

  let ticker = stock.ticker;

  // 念のためここでも正規化（4桁の日本株形式なら .T を付与）
  if (ticker && /^[0-9][0-9A-Z][0-9][0-9A-Z]$/.test(ticker.toUpperCase())) {
    ticker = ticker.toUpperCase() + '.T';
    stock.ticker = ticker; // 修正後のコードを保存
  }

  try {
    // GAS経由でデータを取得 (tickerを直接渡す形式に変更)
    const data = await fetchWithProxy(ticker);
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;

    if (price) {
      portfolio[index].currentPrice = price;
      portfolio[index].fetchFailed = false;
      // 個別に savePortfolio() は呼ばず、updatePrices 側で一括保存するように変更
    } else {
      throw new Error('Price not found in data');
    }
  } catch (error) {
    console.error(`GAS Fetch error for ${ticker}:`, error.message);
    portfolio[index].fetchFailed = true;
  }
}

/**
 * 全銘柄の株価を一括更新する
 * API制限を考慮して順番に取得（1秒間隔）
 */
async function updatePrices() {
  if (isUpdatingPrices) return;
  if (portfolio.length === 0) {
    showToast('更新する銘柄がありません', 'info');
    return;
  }

  isUpdatingPrices = true;
  // ボタンをローディング状態に
  const refreshBtn = document.getElementById('btn-refresh');
  let originalText = '';
  if (refreshBtn) {
    originalText = refreshBtn.innerHTML;
    refreshBtn.innerHTML = '🔄 更新中…<span class="loading-spinner"></span>';
    refreshBtn.disabled = true;
  }

  showToast('株価を更新しています…', 'info');

  try {
    // 順番に株価を取得（APIレート制限対策のため1秒間隔）
    for (let i = 0; i < portfolio.length; i++) {
      await fetchStockPrice(i);

      // 最後の銘柄以外は1秒待機
      if (i < portfolio.length - 1) {
        await sleep(1000);
      }
    }

    // 全ての株価取得が完了した後に画面と履歴を更新
    renderPortfolio();
    calculateSummary();
    renderPieChart();

    // データをクラウドとローカルに保存（一括で1回だけ実行して効率化）
    await savePortfolio();
    savePortfolioHistory();
    renderHistoryChart();

    // 最終更新時刻を更新
    const timeEl = document.getElementById('last-update-time');
    const outerEl = document.getElementById('last-update-outer');
    if (timeEl && outerEl) {
      const now = new Date();
      timeEl.textContent = now.toLocaleTimeString('ja-JP');
      outerEl.style.display = 'block';
    }

    showToast('株価の更新が完了しました', 'success');
  } catch (error) {
    console.error('株価の更新中にエラーが発生しました:', error);
    showToast('更新中に一部エラーが発生しました', 'error');
  } finally {
    // ボタンを元に戻す
    if (refreshBtn) {
      refreshBtn.innerHTML = originalText;
      refreshBtn.disabled = false;
    }
    isUpdatingPrices = false;
  }
}

// =========================================================
// グローバルに関数を公開（onclickイベント等からアクセス可能にする）
// =========================================================

/**
 * 損益確定モーダルを開く
 * @param {number} index - 売却する銘柄のインデックス
 */
function openSellModal(index) {
  const stock = portfolio[index];
  if (!stock) return;

  const currentPriceJpy = stock.currentPrice !== null ? convertToJpy(stock.currentPrice, stock.ticker) : null;
  const defaultPrice = currentPriceJpy !== null ? currentPriceJpy : stock.buyPrice;

  document.getElementById('sell-modal-index').value = index;
  document.getElementById('sell-modal-stock-name').textContent = `${stock.name} (${stock.ticker})`;
  
  const priceInput = document.getElementById('input-sell-price');
  priceInput.value = defaultPrice.toFixed(2);
  
  const sharesInput = document.getElementById('input-sell-shares');
  sharesInput.value = stock.shares; // デフォルトで全数
  sharesInput.max = stock.shares;

  document.getElementById('sell-modal-info').textContent = `購入価格: ¥${formatNumber(stock.buyPrice)} / 保有数: ${stock.shares}株`;

  document.getElementById('sell-modal').style.display = 'flex';
}

/**
 * 損益確定モーダルを閉じる
 */
function closeSellModal() {
  document.getElementById('sell-modal').style.display = 'none';
  document.getElementById('input-sell-price').value = '';
  document.getElementById('input-sell-shares').value = '';
}

/**
 * 損益を確定して銘柄を削除する
 */
function confirmSellStock() {
  const indexStr = document.getElementById('sell-modal-index').value;
  const sellPriceStr = document.getElementById('input-sell-price').value;
  const sellSharesStr = document.getElementById('input-sell-shares').value;

  if (indexStr === '' || sellPriceStr === '' || sellSharesStr === '') return;

  const index = parseInt(indexStr, 10);
  const sellPrice = parseFloat(sellPriceStr);
  const sellShares = parseInt(sellSharesStr, 10);

  const stock = portfolio[index];
  if (!stock || isNaN(sellPrice) || sellPrice <= 0 || isNaN(sellShares) || sellShares <= 0) {
    showToast('正しい価格と株数を入力してください', 'error');
    return;
  }

  if (sellShares > stock.shares) {
    showToast('保有株数を超える売却はできません', 'error');
    return;
  }

  // 履歴に追加
  const historyItem = {
    id: Date.now(),
    name: stock.name,
    ticker: stock.ticker,
    buyPrice: stock.buyPrice,
    sellPrice: sellPrice,
    shares: sellShares,
    date: new Date().toISOString().split('T')[0]
  };
  realizedHistory.push(historyItem);

  // ポートフォリオの更新
  if (sellShares === stock.shares) {
    // 全数売却
    portfolio.splice(index, 1);
  } else {
    // 一部売却
    stock.shares -= sellShares;
  }

  // 保存と画面更新
  savePortfolio();
  renderPortfolio();
  calculateSummary();
  renderPieChart();
  savePortfolioHistory();
  renderHistoryChart();

  closeSellModal();
  // サマリー計算後に realizedPnl が更新されるので、それを使ってトースト表示してもよいが、ここでは個別の pnl を再計算
  const itemPnl = (sellPrice - stock.buyPrice) * sellShares;
  const pnlText = (itemPnl >= 0 ? '+' : '-') + '¥' + formatNumber(Math.abs(itemPnl));
  showToast(`${stock.name} を ${sellShares}株 確定しました（損益: ${pnlText}）`, 'success');
}

window.openSellModal = openSellModal;
window.closeSellModal = closeSellModal;
window.confirmSellStock = confirmSellStock;

/**
 * 履歴確認モーダルを開く
 */
function openHistoryModal() {
  document.getElementById('history-modal').style.display = 'flex';
  renderHistory();
}

/**
 * 履歴確認モーダルを閉じる
 */
function closeHistoryModal() {
  document.getElementById('history-modal').style.display = 'none';
}

/**
 * 履歴一覧をレンダリングする
 */
function renderHistory() {
  const container = document.getElementById('history-list-container');
  container.innerHTML = '';

  if (realizedHistory.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 2rem;">確定履歴がありません</p>';
    return;
  }

  // 新しい順に表示
  [...realizedHistory].reverse().forEach((item) => {
    const pnl = (item.sellPrice - item.buyPrice) * item.shares;
    
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="history-item__info">
        <span class="history-item__name">${escapeHtml(item.name)} (${escapeHtml(item.ticker)})</span>
        <span class="history-item__sub">売却日: ${item.date} / 購入: ¥${formatNumber(item.buyPrice)} / 売却: ¥${formatNumber(item.sellPrice)} / ${item.shares}株</span>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-lg);">
        <span class="history-item__pnl" style="color: ${pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
          ${pnl >= 0 ? '+' : '-'}¥${formatNumber(Math.abs(pnl))}
        </span>
        <div class="history-item__actions">
          <button class="btn btn--secondary" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;" onclick="window.openEditHistoryModal(${item.id})">編集</button>
          <button class="btn btn--danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;" onclick="window.openDeleteConfirmModal(${item.id})">削除</button>
        </div>
      </div>
    `;
    container.appendChild(div);
  });
}

/**
 * 履歴編集モーダルを開く
 */
function openEditHistoryModal(id) {
  const item = realizedHistory.find(h => h.id === id);
  if (!item) return;

  document.getElementById('edit-history-id').value = id;
  document.getElementById('edit-history-stock-name').textContent = `${item.name} (${item.ticker})`;
  document.getElementById('input-edit-sell-price').value = item.sellPrice;
  
  document.getElementById('edit-history-modal').style.display = 'flex';
}

/**
 * 履歴編集モーダルを閉じる
 */
function closeEditHistoryModal() {
  document.getElementById('edit-history-modal').style.display = 'none';
}

/**
 * 履歴の編集を確定する
 */
function confirmEditHistory() {
  const id = parseInt(document.getElementById('edit-history-id').value, 10);
  const newPrice = parseFloat(document.getElementById('input-edit-sell-price').value);

  if (isNaN(newPrice) || newPrice <= 0) {
    showToast('正しい価格を入力してください', 'error');
    return;
  }

  const index = realizedHistory.findIndex(h => h.id === id);
  if (index !== -1) {
    realizedHistory[index].sellPrice = newPrice;
    savePortfolio();
    calculateSummary();
    renderHistory();
    closeEditHistoryModal();
    showToast('履歴を更新しました', 'success');
  }
}

/**
 * 削除確認モーダルを開く
 */
function openDeleteConfirmModal(id) {
  document.getElementById('delete-confirm-id').value = id;
  document.getElementById('delete-confirm-modal').style.display = 'flex';
}

/**
 * 削除確認モーダルを閉じる
 */
function closeDeleteConfirmModal() {
  document.getElementById('delete-confirm-modal').style.display = 'none';
}

/**
 * 実際の削除処理を実行する
 */
function executeDeleteHistory() {
  const id = parseInt(document.getElementById('delete-confirm-id').value, 10);
  const index = realizedHistory.findIndex(h => h.id === id);
  
  if (index !== -1) {
    const item = realizedHistory[index];
    realizedHistory.splice(index, 1);
    
    savePortfolio();
    calculateSummary();
    renderHistory();
    
    showToast(`${item.name} の履歴を削除しました`, 'info');
  }
  
  closeDeleteConfirmModal();
}

window.openHistoryModal = openHistoryModal;
window.closeHistoryModal = closeHistoryModal;
window.openEditHistoryModal = openEditHistoryModal;
window.closeEditHistoryModal = closeEditHistoryModal;
window.confirmEditHistory = confirmEditHistory;
window.openDeleteConfirmModal = openDeleteConfirmModal;
window.closeDeleteConfirmModal = closeDeleteConfirmModal;
window.executeDeleteHistory = executeDeleteHistory;
window.deleteStock = deleteStock;
window.loginWithGoogle = loginWithGoogle;
window.logout = logout;

// =========================================================
// 円グラフ（銘柄比率） — Chart.js
// =========================================================

/**
 * ポートフォリオの銘柄比率を Doughnut Chart で描画する
 */
function renderPieChart() {
  const canvas = document.getElementById('pie-chart');
  const ctx = canvas.getContext('2d');

  // データがない場合
  if (portfolio.length === 0) {
    if (pieChartInstance) {
      pieChartInstance.destroy();
      pieChartInstance = null;
    }
    return;
  }

  // 各銘柄の評価額を計算
  const labels = [];
  const values = [];
  const colors = generateColors(portfolio.length);

  portfolio.forEach((stock) => {
    const priceJpy = stock.currentPrice !== null ? convertToJpy(stock.currentPrice, stock.ticker) : stock.buyPrice;
    const value = priceJpy * stock.shares;
    labels.push(`${stock.name} (${stock.ticker})`);
    values.push(value);
  });

  // 既存のチャートがあれば破棄
  if (pieChartInstance) {
    pieChartInstance.destroy();
  }

  // Doughnut Chart を作成
  pieChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: '#0f172a',
        borderWidth: 3,
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#94a3b8',
            padding: 20,
            font: {
              family: "'Inter', sans-serif",
              size: 12,
            },
            usePointStyle: true,
            pointStyleWidth: 10,
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          titleColor: '#f8fafc',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          usePointStyle: true,
          cornerRadius: 8,
          padding: 12,
          callbacks: {
            label: function(context) {
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = ((context.raw / total) * 100).toFixed(1);
              return ` ¥${formatNumber(context.raw)} (${percentage}%)`;
            }
          }
        }
      },
      cutout: '60%',
    }
  });
}

// =========================================================
// 生涯損益（数字表示）
// =========================================================

/**
 * 生涯損益の Line Chart を描画する（※廃止）
 */
function renderHistoryChart() {
  // グラフ描画は廃止（数字への直接表示に変更）のため処理なし
}

/**
 * 現在のポートフォリオ生涯損益を履歴に保存する（※廃止）
 */
function savePortfolioHistory() {
  // グラフ描画は廃止のためデータの保存処理もスキップ
}

// =========================================================
// ユーティリティ関数
// =========================================================

/**
 * 数値をカンマ区切りでフォーマットする（小数点2桁）
 * @param {number} num - フォーマットする数値
 * @returns {string} フォーマット済みの文字列
 */
function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  // 円表示なので、小数点以下はなし（または、日本円らしく整数のカンマ区切り）
  return Math.round(num).toLocaleString('ja-JP');
}

/**
 * HTMLをエスケープしてXSSを防止する
 * @param {string} text - エスケープするテキスト
 * @returns {string} エスケープ済みテキスト
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

/**
 * 指定ミリ秒だけ待機する（Promise版）
 * @param {number} ms - 待機ミリ秒数
 * @returns {Promise} 待機後に解決するPromise
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 指定数の色を生成する（円グラフ用）
 * @param {number} count - 生成する色の数
 * @returns {string[]} 色の配列
 */
function generateColors(count) {
  const baseColors = [
    '#6366f1', // Indigo
    '#8b5cf6', // Violet
    '#10b981', // Emerald
    '#f43f5e', // Rose
    '#f59e0b', // Amber
    '#0ea5e9', // Sky
    '#ec4899', // Pink
    '#14b8a6', // Teal
    '#f97316', // Orange
    '#d946ef', // Fuchsia
    '#06b6d4', // Cyan
    '#84cc16', // Lime
  ];

  const colors = [];
  for (let i = 0; i < count; i++) {
    colors.push(baseColors[i % baseColors.length]);
  }
  return colors;
}

/**
 * トースト通知を表示する
 * @param {string} message - 表示するメッセージ
 * @param {string} type - 'success' | 'error' | 'info'
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  // 3秒後に自動削除
  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 3000);
}
// =========================================================
// グローバルに関数を公開（onclickイベント等からアクセス可能にする）
// =========================================================
window.addStock = addStock;
window.deleteStock = deleteStock;
window.updatePrices = updatePrices;
