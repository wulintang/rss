// 工具函数：处理 RSS 登录、数据获取和格式化
const fetch = require('node-fetch');

// 缓存逻辑（内存缓存，Vercel 函数实例复用期间有效）
let cache = {
  data: null,
  expireTime: 0
};

// 配置（从环境变量读取敏感信息）
const config = {
  apiUrl: 'https://rss.dao.js.cn/p/api/greader.php',
  user: process.env.RSS_USER,
  password: process.env.RSS_PASS,
  cacheTTL: 300,                    // 缓存有效期（5分钟）
  batchSize: 10,                    // 每批处理的订阅数量
  maxRetries: 3                     // 请求失败重试次数
};

/**
 * 主函数：获取并处理所有订阅文章
 */
async function getRssArticles() {
  // 检查缓存是否有效
  if (cache.data && Date.now() < cache.expireTime) {
    console.log('使用缓存数据');
    return cache.data;
  }

  try {
    // 1. 登录获取认证令牌
    const authToken = await login();
    if (!authToken) {
      throw new Error('登录失败');
    }

    // 2. 获取所有订阅源
    const subscriptions = await getSubscriptions(authToken);
    if (!subscriptions || subscriptions.length === 0) {
      throw new Error('未获取到订阅列表');
    }

    // 3. 分批处理订阅
    const allArticles = {};
    const batches = chunkArray(subscriptions, config.batchSize);

    for (const [batchIndex, batch] of batches.entries()) {
      console.log(`处理第 ${batchIndex + 1}/${batches.length} 批订阅`);
      
      for (const sub of batch) {
        const streamId = sub.id;
        const siteName = sub.title || '未知站点';
        
        // 4. 获取该订阅的文章
        const articles = await fetchArticles(authToken, streamId);
        if (!articles || articles.length === 0) {
          console.log(`订阅 ${siteName} 无新内容`);
          continue;
        }

        // 5. 格式化文章数据
        const formatted = formatArticles(articles, sub);
        
        // 6. 合并到结果（每个站点保留最新10条）
        allArticles[siteName] = [
          ...formatted, 
          ...(allArticles[siteName] || [])
        ].slice(0, 10);
      }

      // 每批处理后短暂休眠
      await sleep(500);
    }

    // 更新缓存
    cache.data = allArticles;
    cache.expireTime = Date.now() + config.cacheTTL * 1000;
    console.log('数据处理完成，已更新缓存');
    return allArticles;

  } catch (error) {
    console.error('处理失败：', error.message);
    // 缓存未过期时，返回旧数据
    if (cache.data) {
      console.log('返回缓存的旧数据');
      return cache.data;
    }
    throw error;
  }
}

/**
 * 登录并获取认证令牌
 */
async function login() {
  const loginUrl = `${config.apiUrl}/accounts/ClientLogin?Email=${encodeURIComponent(config.user)}&Passwd=${encodeURIComponent(config.password)}`;
  
  try {
    const response = await fetchWithRetry(loginUrl);
    const text = await response.text();
    
    if (text.includes('Auth=')) {
      return text.split('Auth=')[1].trim();
    }
    return null;
  } catch (error) {
    console.error('登录请求失败：', error.message);
    return null;
  }
}

/**
 * 获取所有订阅源列表
 */
async function getSubscriptions(authToken) {
  const url = `${config.apiUrl}/reader/api/0/subscription/list?output=json`;
  
  try {
    const response = await fetchWithRetry(url, {
      headers: { 'Authorization': `GoogleLogin auth=${authToken}` }
    });
    const data = await response.json();
    return data.subscriptions || [];
  } catch (error) {
    console.error('获取订阅列表失败：', error.message);
    return [];
  }
}

/**
 * 获取单个订阅源的文章（支持重试）
 */
async function fetchArticles(authToken, streamId) {
  const url = `${config.apiUrl}/reader/api/0/stream/contents/${encodeURIComponent(streamId)}?n=1000`;
  
  try {
    const response = await fetchWithRetry(url, {
      headers: { 'Authorization': `GoogleLogin auth=${authToken}` }
    });
    const data = await response.json();
    return data.items ? sortArticlesByTime(data.items) : [];
  } catch (error) {
    console.error(`获取订阅 ${streamId} 失败：`, error.message);
    return [];
  }
}

/**
 * 格式化文章数据
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
 * 带重试的 fetch 请求
 */
async function fetchWithRetry(url, options = {}, retries = 0) {
  try {
    const response = await fetch(url, {
      ...options,
      timeout: 10000
    });
    
    if (!response.ok) {
      throw new Error(`HTTP 状态码错误: ${response.status}`);
    }
    return response;
  } catch (error) {
    if (retries < config.maxRetries) {
      console.log(`请求 ${url} 失败，重试 ${retries + 1}/${config.maxRetries}`);
      await sleep(1000 * (retries + 1));
      return fetchWithRetry(url, options, retries + 1);
    }
    throw error;
  }
}

/**
 * 按发布时间降序排序文章
 */
function sortArticlesByTime(articles) {
  return articles.sort((a, b) => (b.published || 0) - (a.published || 0));
}

/**
 * 分割数组为批次
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * 休眠指定毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 去除 HTML 标签
 */
function stripTags(html) {
  return html.replace(/<[^>]*>?/gm, '');
}

module.exports = { getRssArticles };
    
