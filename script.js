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

/** 利用可能なCORSプロキシのリスト（GitHub Pagesで動作しやすいものを優先） */
const PROXY_LIST = [
  'https://api.allorigins.win/get?url=',      // JSONラップされるが安定
  'https://api.codetabs.com/v1/proxy?quest=', // そのままのレスポンス
  'https://corsproxy.io/?',                 // fallback (localhost以外は403の可能性あり)
  'https://thingproxy.freeboard.io/fetch/'   // 非常にシンプル
];

/** Yahoo Finance APIのベースURL */
const YAHOO_API_BASE = 'https://query2.finance.yahoo.com/v8/finance/chart/';

/** 為替レート（USD/JPY）のデフォルト値 */
let usdjpyRate = 150;
/** 為替レート取得済みフラグ */
let isRateFetched = false;

/** プロキシ経由でデータを取得する共通関数 */
async function fetchWithProxy(targetUrl) {
  let lastError = null;
  
  for (const proxy of PROXY_LIST) {
    try {
      const url = `${proxy}${encodeURIComponent(targetUrl)}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        console.warn(`Proxy returned status ${response.status}: ${proxy}`);
        continue;
      }
      
      const data = await response.json();
      
      // Allorigins (+ /get/) の場合は 'contents' プロパティに生の文字列が入っている
      if (proxy.includes('allorigins.win/get')) {
        if (data.contents) {
          try {
            return JSON.parse(data.contents);
          } catch (e) {
            console.warn('Allorigins contents JSON parse error');
            continue;
          }
        }
      }
      
      return data;
    } catch (e) {
      console.warn(`Proxy failed: ${proxy}`, e.message);
      lastError = e;
    }
    
    // 短いウェイト
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw lastError || new Error('全てのプロキシで取得に失敗しました');
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
    currentUser = user;
    updateAuthUI();

    if (user) {
      // ログイン時はFirestoreから取得
      await loadFromFirestore();
    } else {
      // 未ログイン時はLocalStorageから取得
      portfolio = [];
      portfolioHistory = [];
      realizedHistory = [];
      await loadPortfolio();
    }

    // 画面を共通で描画 (株価更新も含む)
    refreshUI();
  });

  // 購入日のデフォルト値を今日に設定
  const dateInput = document.getElementById('input-date');
  if (dateInput) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }

  // 銘柄が存在する場合、株価を取得して資産履歴を保存
  if (portfolio.length > 0) {
    updatePrices();
  } else {
    // 銘柄が0の場合でも初期の実現損益を履歴として記録・描画
    savePortfolioHistory();
    renderHistoryChart();
  }

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
      
      // 日本の4桁銘柄コードが入力された場合、自動で .T を付与する
      if (/^\d{4}$/.test(ticker)) {
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
        const targetUrl = YAHOO_API_BASE + ticker + '?range=1d&interval=1d';
        const data = await fetchWithProxy(targetUrl);
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
  // ポップアップでのログインを試行
  try {
    const result = await auth.signInWithPopup(provider);
    showToast(`${result.user.displayName} さんとしてログインしました`, 'success');
  } catch (error) {
    console.error('Login error:', error);
    if (error.code === 'auth/unauthorized-domain') {
      showToast('このドメインからのログインは許可されていません。Firebaseの設定を確認してください。', 'error');
    } else if (error.code === 'auth/popup-blocked') {
      showToast('ポップアップがブロックされました。ブラウザの設定を変更してください。', 'info');
    } else {
      showToast(`ログインに失敗しました (${error.message})`, 'error');
    }
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
  try {
    // 為替レートは共通で取得
    await fetchExchangeRate();

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
  }
}

/**
 * LocalStorageからポートフォリオと履歴を読み込む
 */
async function loadPortfolio() {
  try {
    const savedPortfolio = localStorage.getItem('portfolio');
    const savedHistory = localStorage.getItem('lifetimePnlHistory');
    const savedRealizedHistory = localStorage.getItem('realizedHistory');

    // 為替レートを取得
    await fetchExchangeRate();

    // ポートフォリオデータの復元
    if (savedPortfolio) {
      portfolio = JSON.parse(savedPortfolio);
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
  
  // 日本の4桁銘柄コードが入力された場合、自動で .T を付与する
  if (/^\d{4}$/.test(ticker)) {
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

    tr.innerHTML = `
      <td>${escapeHtml(stock.name)}</td>
      <td class="ticker-cell">${escapeHtml(stock.ticker)}</td>
      <td>¥${formatNumber(buyPriceJpy)}</td>
      <td>${priceDisplay}</td>
      <td>${stock.shares.toLocaleString()}</td>
      <td>${marketValue !== null ? '¥' + formatNumber(marketValue) : '—'}</td>
      <td class="${pnlClass}">
        ${pnl !== null ? (pnl >= 0 ? '+' : '-') + '¥' + formatNumber(Math.abs(pnl)) : '—'}
      </td>
      <td style="display: flex; flex-direction: column; gap: var(--space-xs);">
        <button class="btn btn--danger" onclick="window.deleteStock(${index})">削除</button>
        <button class="btn btn--secondary" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;" onclick="window.openSellModal(${index})">損益確定</button>
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

  // DOM要素を更新
  document.getElementById('total-investment').textContent = '¥' + formatNumber(totalInvestment);

  const currentEl = document.getElementById('total-current');
  currentEl.textContent = hasCurrentPrice ? '¥' + formatNumber(totalCurrent) : '—';

  const pnlEl = document.getElementById('total-pnl');
  pnlEl.textContent = hasCurrentPrice
    ? (totalPnl >= 0 ? '+¥' : '-¥') + formatNumber(Math.abs(totalPnl))
    : '—';

  // 損益に応じた色を適用
  pnlEl.style.color = '';
  if (hasCurrentPrice) {
    pnlEl.style.color = totalPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  }

  // 実現損益の更新（履歴配列から再計算）
  realizedPnl = realizedHistory.reduce((sum, item) => {
    // 通貨換算（確定時のレートは不明なので現在のレートを使用するか、確定時に計算済みの値を保持すべきだが、ここでは簡略化のため現在レート基準）
    const isJapanese = item.ticker.endsWith('.T') || item.ticker.endsWith('.TK');
    const itemSellPriceJpy = isJapanese ? item.sellPrice : item.sellPrice * usdjpyRate;
    const itemBuyPriceJpy = item.buyPrice; // すでに円で保存されている想定
    return sum + (itemSellPriceJpy - itemBuyPriceJpy) * item.shares;
  }, 0);

  const realizedEl = document.getElementById('realized-pnl');
  if (realizedEl) {
    realizedEl.textContent = (realizedPnl >= 0 ? '+¥' : '-¥') + formatNumber(Math.abs(realizedPnl));
    realizedEl.style.color = realizedPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  }

  // 生涯損益（数字表示）の更新
  const lifetimePnl = totalPnl + realizedPnl;
  const lifetimeEl = document.getElementById('lifetime-pnl-display');
  if (lifetimeEl) {
    lifetimeEl.textContent = (lifetimePnl >= 0 ? '+¥' : '-¥') + formatNumber(Math.abs(lifetimePnl));
    lifetimeEl.style.color = lifetimePnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  }
}

// =========================================================
// 株価API連携（Yahoo Finance — APIキー不要）
// =========================================================

/**
 * 為替レート（USD/JPY）を取得する
 */
async function fetchExchangeRate() {
  try {
    const targetUrl = YAHOO_API_BASE + 'USDJPY=X?range=1d&interval=1d';
    const data = await fetchWithProxy(targetUrl);
    const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (rate) {
      usdjpyRate = rate;
      isRateFetched = true;
      console.log(`為替レート更新: USD/JPY = ${usdjpyRate}`);
    }
  } catch (error) {
    console.warn('為替レートの取得に失敗しました。デフォルト値を使用します:', error.message);
  }
}

/**
 * 通貨換算を行う（銘柄が米国株の場合は円に換算）
 * @param {number} price - 元の価格
 * @param {string} ticker - ティッカーシンボル
 * @returns {number} 換算後の価格（円）
 */
function convertToJpy(price, ticker) {
  if (!price) return 0;
  // 日本株（.T または .TK）以外は米国株とみなして換算
  const isJapanese = ticker.endsWith('.T') || ticker.endsWith('.TK');
  return isJapanese ? price : price * usdjpyRate;
}

/**
 * 指定インデックスの銘柄の現在株価を取得する
 * Yahoo Finance Chart API を CORSプロキシ経由で呼び出す
 * @param {number} index - ポートフォリオ内の銘柄インデックス
 */
async function fetchStockPrice(index) {
  const stock = portfolio[index];
  if (!stock) return;

  const ticker = stock.ticker;

  try {
    // Yahoo Finance Chart APIにリクエスト
    const targetUrl = YAHOO_API_BASE + ticker + '?range=1d&interval=1d';
    const data = await fetchWithProxy(targetUrl);

    // レスポンスから現在価格を取得
    const result = data?.chart?.result?.[0];
    if (!result) {
      throw new Error('データが見つかりません');
    }

    // 現在価格を取得（regularMarketPrice を優先）
    const meta = result.meta;
    const rawPrice = meta?.regularMarketPrice ?? null;

    if (rawPrice !== null) {
      // ポートフォリオデータを更新（エラーフラグも解除）
      portfolio[index].currentPrice = rawPrice;
      portfolio[index].fetchFailed = false;
      savePortfolio();
    }
  } catch (error) {
    console.warn(`${ticker} の株価取得に失敗しました:`, error.message);
    portfolio[index].fetchFailed = true;
    showToast(`${ticker} の株価が取得できませんでした`, 'error');
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

    // 全ての株価取得が完了した後に1回だけ画面を更新（チラつき防止）
    renderPortfolio();
    calculateSummary();
    renderPieChart();

    // 資産履歴を保存
    savePortfolioHistory();
    renderHistoryChart();

    // 最終更新時刻を更新
    const timeEl = document.getElementById('last-update-time');
    const outerEl = document.getElementById('last-update-outer');
    if (timeEl && outerEl) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      timeEl.textContent = timeStr;
      outerEl.style.display = 'block'; // 初回表示時に有効化
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
  
  document.getElementById('sell-modal-info').textContent = `購入価格: ¥${formatNumber(stock.buyPrice)} / 株数: ${stock.shares}株`;

  document.getElementById('sell-modal').style.display = 'flex';
}

/**
 * 損益確定モーダルを閉じる
 */
function closeSellModal() {
  document.getElementById('sell-modal').style.display = 'none';
  document.getElementById('input-sell-price').value = '';
}

/**
 * 損益を確定して銘柄を削除する
 */
function confirmSellStock() {
  const indexStr = document.getElementById('sell-modal-index').value;
  const sellPriceStr = document.getElementById('input-sell-price').value;

  if (indexStr === '' || sellPriceStr === '') return;

  const index = parseInt(indexStr, 10);
  const sellPrice = parseFloat(sellPriceStr);

  const stock = portfolio[index];
  if (!stock || isNaN(sellPrice) || sellPrice <= 0) {
    showToast('正しい売却価格を入力してください', 'error');
    return;
  }

  // 損益計算（円）
  // 注意: stock.buyPrice はすでに入力時に円になっている想定
  // sellPriceJpy を計算
  // const sellPriceJpy = stock.ticker.endsWith('.T') || stock.ticker.endsWith('.TK') ? sellPrice : sellPrice * usdjpyRate;
  // const pnl = (sellPriceJpy - stock.buyPrice) * stock.shares;

  // 履歴に追加
  const historyItem = {
    id: Date.now(),
    name: stock.name,
    ticker: stock.ticker,
    buyPrice: stock.buyPrice,
    sellPrice: sellPrice, // 通貨元の価格で保持
    shares: stock.shares,
    date: new Date().toISOString().split('T')[0]
  };
  realizedHistory.push(historyItem);

  // ポートフォリオから削除
  portfolio.splice(index, 1);

  // 保存と画面更新
  savePortfolio();
  renderPortfolio();
  calculateSummary();
  renderPieChart();
  savePortfolioHistory();
  renderHistoryChart();

  closeSellModal();
  // サマリー計算後に realizedPnl が更新されるので、それを使ってトースト表示してもよいが、ここでは個別の pnl を再計算
  const isJapanese = stock.ticker.endsWith('.T') || stock.ticker.endsWith('.TK');
  const spJpy = isJapanese ? sellPrice : sellPrice * usdjpyRate;
  const itemPnl = (spJpy - stock.buyPrice) * stock.shares;
  const pnlText = (itemPnl >= 0 ? '+' : '-') + '¥' + formatNumber(Math.abs(itemPnl));
  showToast(`${stock.name} を確定しました（損益: ${pnlText}）`, 'success');
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
    const isJapanese = item.ticker.endsWith('.T') || item.ticker.endsWith('.TK');
    const sellPriceJpy = isJapanese ? item.sellPrice : item.sellPrice * usdjpyRate;
    const pnl = (sellPriceJpy - item.buyPrice) * item.shares;
    
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="history-item__info">
        <span class="history-item__name">${escapeHtml(item.name)} (${escapeHtml(item.ticker)})</span>
        <span class="history-item__sub">売却日: ${item.date} / 購入: ¥${formatNumber(item.buyPrice)} / 売却: ¥${formatNumber(sellPriceJpy)} / ${item.shares}株</span>
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
            color: '#e2e8f0',
            padding: 16,
            font: {
              family: "'Inter', sans-serif",
              size: 12,
            },
            usePointStyle: true,
            pointStyleWidth: 10,
          }
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          borderColor: '#334155',
          borderWidth: 1,
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
    '#3b82f6', // ブルー
    '#a855f7', // パープル
    '#22c55e', // グリーン
    '#f59e0b', // アンバー
    '#ef4444', // レッド
    '#06b6d4', // シアン
    '#ec4899', // ピンク
    '#14b8a6', // ティール
    '#f97316', // オレンジ
    '#8b5cf6', // ヴァイオレット
    '#64748b', // グレー
    '#eab308', // イエロー
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
