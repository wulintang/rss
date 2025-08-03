// 工具函数：处理 RSS 登录、数据获取和格式化
const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie'); // 新增：处理Cookie，需安装 npm install tough-cookie
const fetchCookie = require('fetch-cookie'); // 新增：自动处理Cookie，需安装 npm install fetch-cookie

// 创建带Cookie的fetch实例（模仿PHP curl自动处理Cookie）
const cookieJar = new CookieJar();
const fetchWithCookie = fetchCookie(fetch, cookieJar);

// 缓存逻辑
let cache = {
  data: null,
  expireTime: 0
};

// 配置（从环境变量读取）
const config = {
  apiUrl: 'https://rss.dao.js.cn/p/api/greader.php',
  user: process.env.RSS_USER,
  password: process.env.RSS_PASS,
  cacheTTL: 300,
  batchSize: 10,
  maxRetries: 3
};

/**
 * 主函数：获取并处理所有订阅文章
 */
async function getRssArticles() {
  if (cache.data && Date.now() < cache.expireTime) {
    console.log('使用缓存数据');
    return cache.data;
  }

  try {
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

    for (const [batchIndex, batch] of batches.entries()) {
      console.log(`处理第 ${batchIndex + 1}/${batches.length} 批订阅`);
      
      for (const sub of batch) {
        const streamId = sub.id;
        const siteName = sub.title || '未知站点';
        
        const articles = await fetchArticles(authToken, streamId);
        if (!articles || articles.length === 0) {
          console.log(`订阅 ${siteName} 无新内容`);
          continue;
        }

        const formatted = formatArticles(articles, sub);
        allArticles[siteName] = [
          ...formatted, 
          ...(allArticles[siteName] || [])
        ].slice(0, 10);
      }

      await sleep(500);
    }

    cache.data = allArticles;
    cache.expireTime = Date.now() + config.cacheTTL * 1000;
    console.log('数据处理完成，已更新缓存');
    return allArticles;

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
 * 完全复刻PHP curl的登录逻辑（解决403问题）
 */
async function login() {
  try {
    // 1. 完全模仿PHP的urlencode
    const encodedUser = phpUrlEncode(config.user);
    const encodedPass = phpUrlEncode(config.password);
    const loginUrl = `${config.apiUrl}/accounts/ClientLogin?Email=${encodedUser}&Passwd=${encodedPass}`;
    console.log('登录请求 URL:', loginUrl);

    // 2. 模仿PHP curl的默认请求头（关键：添加浏览器标识）
    const headers = {
      'User-Agent': 'curl/7.68.0', // 用curl的默认UA，与PHP curl一致
      'Accept': '*/*',
      'Referer': 'https://rss.dao.js.cn/' // 添加来源页，模拟正常访问
    };

    // 3. 用带Cookie的fetch发送请求（模仿PHP自动处理Cookie）
    const response = await fetchWithRetry(loginUrl, { headers }, fetchWithCookie);
    
    // 4. 检查状态码（PHP curl不会主动判断状态码，这里兼容）
    console.log('登录响应状态码:', response.status);
    const text = await response.text();
    console.log('登录响应原始内容:', text);

    // 5. 提取Auth令牌（与PHP逻辑完全一致）
    const authPos = text.indexOf('Auth=');
    if (authPos !== -1) {
      const authToken = text.substring(authPos + 5).trim();
      console.log('登录成功，Auth令牌:', authToken);
      return authToken;
    }

    console.error('未找到Auth令牌');
    return null;
  } catch (error) {
    console.error('登录请求异常:', error.message);
    return null;
  }
}

/**
 * 带Cookie支持的重试请求函数
 */
async function fetchWithRetry(url, options = {}, fetchImpl = fetch, retries = 0) {
  try {
    const response = await fetchImpl(url, {
      ...options,
      timeout: 15000, // 延长超时，确保请求完成
      redirect: 'follow' // 自动跟随重定向（PHP curl默认行为）
    });
    
    // 即使状态码非200也返回内容（PHP curl不会因403拒绝返回内容）
    return response;
  } catch (error) {
    if (retries < config.maxRetries) {
      console.log(`请求 ${url} 失败，重试 ${retries + 1}/${config.maxRetries}`);
      await sleep(1000 * (retries + 1));
      return fetchWithRetry(url, options, fetchImpl, retries + 1);
    }
    throw error;
  }
}

/**
 * 以下函数保持不变，仅调整fetch为带Cookie的版本
 */
async function getSubscriptions(authToken) {
  const url = `${config.apiUrl}/reader/api/0/subscription/list?output=json`;
  
  try {
    const response = await fetchWithRetry(url, {
      headers: { 
        'Authorization': `GoogleLogin auth=${authToken}`,
        'User-Agent': 'curl/7.68.0' // 保持UA一致
      }
    }, fetchWithCookie);
    const data = await response.json();
    return data.subscriptions || [];
  } catch (error) {
    console.error('获取订阅列表失败：', error.message);
    return [];
  }
}

async function fetchArticles(authToken, streamId) {
  const url = `${config.apiUrl}/reader/api/0/stream/contents/${encodeURIComponent(streamId)}?n=1000`;
  
  try {
    const response = await fetchWithRetry(url, {
      headers: { 
        'Authorization': `GoogleLogin auth=${authToken}`,
        'User-Agent': 'curl/7.68.0' // 保持UA一致
      }
    }, fetchWithCookie);
    const data = await response.json();
    return data.items ? sortArticlesByTime(data.items) : [];
  } catch (error) {
    console.error(`获取订阅 ${streamId} 失败：`, error.message);
    return [];
  }
}

// 其他工具函数（与之前一致）
function phpUrlEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

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
    
