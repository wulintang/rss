// 工具函数：处理 RSS 登录、数据获取和格式化
const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const fetchCookie = require('fetch-cookie');

// 创建带Cookie的fetch实例
const cookieJar = new CookieJar();
const fetchWithCookie = fetchCookie(fetch, cookieJar);

// 缓存逻辑（增强：增加缓存失效检查）
let cache = {
  data: null,
  expireTime: 0,
  lastUpdated: 0
};

// 配置（极致优化参数）
const config = {
  apiUrl: 'https://rss.dao.js.cn/p/api/greader.php',
  user: process.env.RSS_USER,
  password: process.env.RSS_PASS,
  cacheTTL: 600,          // 缓存延长到10分钟，减少重复处理
  batchSize: 3,           // 每批仅处理3个订阅（最小化单批耗时）
  maxRetries: 2,          // 减少重试次数（避免无谓等待）
  sleepBetweenBatches: 200 // 每批间隔缩短到200ms
};

/**
 * 主函数：获取并处理所有订阅文章（增加超时保护）
 */
async function getRssArticles() {
  // 强制使用缓存如果距离上次更新不足3分钟（避免频繁处理）
  if (cache.data && Date.now() - cache.lastUpdated < 180000) {
    console.log('3分钟内已更新，直接使用缓存');
    return cache.data;
  }

  if (cache.data && Date.now() < cache.expireTime) {
    console.log('使用缓存数据');
    return cache.data;
  }

  try {
    // 记录开始时间，防止总耗时过长
    const startTime = Date.now();
    const authToken = await login();
    if (!authToken) {
      throw new Error('登录失败：未获取到 Auth 令牌');
    }

    const subscriptions = await getSubscriptions(authToken);
    if (!subscriptions || subscriptions.length === 0) {
      throw new Error('未获取到订阅列表');
    }

    const allArticles = {};
    const batches = chunkArray(subscriptions, config.batchSize);
    console.log(`共${subscriptions.length}个订阅，分${batches.length}批处理`);

    for (const [batchIndex, batch] of batches.entries()) {
      // 检查总耗时，提前终止避免超时
      if (Date.now() - startTime > 240000) { // 4分钟时停止新批次
        console.log('处理时间接近超时，剩余批次将下次处理');
        break;
      }

      console.log(`处理第 ${batchIndex + 1}/${batches.length} 批订阅`);
      
      // 并行处理单批内的订阅（大幅提升效率）
      await Promise.all(batch.map(async (sub) => {
        const streamId = sub.id;
        const siteName = sub.title || '未知站点';
        
        try {
          const articles = await fetchArticles(authToken, streamId);
          if (!articles || articles.length === 0) {
            console.log(`订阅 ${siteName} 无新内容`);
            return;
          }

          const formatted = formatArticles(articles, sub);
          // 线程安全地更新结果
          allArticles[siteName] = [
            ...(allArticles[siteName] || []),
            ...formatted
          ].slice(0, 10); // 保留最新10条
        } catch (e) {
          console.error(`处理订阅 ${siteName} 出错：`, e.message);
        }
      }));

      // 批次间隔休眠
      await sleep(config.sleepBetweenBatches);
    }

    // 更新缓存（即使未处理完所有批次，也保存已处理结果）
    cache.data = { ...cache.data, ...allArticles }; // 合并新旧结果
    cache.expireTime = Date.now() + config.cacheTTL * 1000;
    cache.lastUpdated = Date.now();
    console.log('数据处理完成，已更新缓存');
    return cache.data;

  } catch (error) {
    console.error('处理失败：', error.message);
    if (cache.data) {
      console.log('返回缓存的旧数据');
      return cache.data;
    }
    throw error;
  }
}

/**
 * 登录函数（保持稳定）
 */
async function login() {
  try {
    const encodedUser = phpUrlEncode(config.user);
    const encodedPass = phpUrlEncode(config.password);
    const loginUrl = `${config.apiUrl}/accounts/ClientLogin?Email=${encodedUser}&Passwd=${encodedPass}`;
    console.log('登录请求 URL:', loginUrl);

    const headers = {
      'User-Agent': 'curl/7.68.0',
      'Accept': '*/*',
      'Referer': 'https://rss.dao.js.cn/'
    };

    const response = await fetchWithRetry(loginUrl, { headers }, fetchWithCookie);
    console.log('登录响应状态码:', response.status);
    const text = await response.text();
    
    const authPos = text.indexOf('Auth=');
    if (authPos !== -1) {
      const authToken = text.substring(authPos + 5).trim();
      console.log('登录成功，Auth令牌获取成功');
      return authToken;
    }

    console.error('未找到Auth令牌，响应内容:', text);
    return null;
  } catch (error) {
    console.error('登录请求异常:', error.message);
    return null;
  }
}

/**
 * 带重试的请求函数（精简超时）
 */
async function fetchWithRetry(url, options = {}, fetchImpl = fetch, retries = 0) {
  try {
    const response = await fetchImpl(url, {
      ...options,
      timeout: 10000, // 单个请求超时缩短到10秒
      redirect: 'follow'
    });
    return response;
  } catch (error) {
    if (retries < config.maxRetries) {
      console.log(`请求 ${url} 失败，重试 ${retries + 1}/${config.maxRetries}`);
      await sleep(500 * (retries + 1)); // 缩短重试间隔
      return fetchWithRetry(url, options, fetchImpl, retries + 1);
    }
    throw error;
  }
}

/**
 * 获取订阅列表（保持稳定）
 */
async function getSubscriptions(authToken) {
  const url = `${config.apiUrl}/reader/api/0/subscription/list?output=json`;
  
  try {
    const response = await fetchWithRetry(url, {
      headers: { 
        'Authorization': `GoogleLogin auth=${authToken}`,
        'User-Agent': 'curl/7.68.0'
      }
    }, fetchWithCookie);
    const data = await response.json();
    return data.subscriptions || [];
  } catch (error) {
    console.error('获取订阅列表失败：', error.message);
    return [];
  }
}

/**
 * 获取单批订阅文章（保持稳定）
 */
async function fetchArticles(authToken, streamId) {
  const url = `${config.apiUrl}/reader/api/0/stream/contents/${encodeURIComponent(streamId)}?n=100`; // 减少单批获取数量
  
  try {
    const response = await fetchWithRetry(url, {
      headers: { 
        'Authorization': `GoogleLogin auth=${authToken}`,
        'User-Agent': 'curl/7.68.0'
      }
    }, fetchWithCookie);
    const data = await response.json();
    return data.items ? sortArticlesByTime(data.items) : [];
  } catch (error) {
    console.error(`获取订阅 ${streamId} 失败：`, error.message);
    return [];
  }
}

/**
 * 格式化文章数据（保持稳定）
 */
function formatArticles(articles, subscription) {
  const iconUrl = `https://rss.dao.js.cn/p/${subscription.iconUrl.split('/').pop()}`;
  
  return articles.map(article => {
    const summary = article.summary?.content || '';
    const cleanSummary = stripTags(summary).replace(/\s+/g, ' ').trim();
    const shortDesc = cleanSummary.length > 100 
      ? cleanSummary.slice(0, 99) + '...' 
      : cleanSummary;

    return {
      site_name: subscription.title || '未知站点',
      title: article.title || '无标题',
      link: article.alternate?.[0]?.href || '#',
      time: new Date(article.published * 1000).toISOString().slice(0, 16).replace('T', ' '),
      description: shortDesc,
      icon: iconUrl
    };
  });
}

/**
 * 辅助函数（保持稳定）
 */
function phpUrlEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function sortArticlesByTime(articles) {
  return articles.sort((a, b) => (b.published || 0) - (a.published || 0));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripTags(html) {
  return html.replace(/<[^>]*>?/gm, '');
}

module.exports = { getRssArticles };
    
