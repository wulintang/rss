// 工具函数：处理 RSS 登录、数据获取和格式化
const fetch = require('node-fetch');

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
 * 优化后的登录函数（替换原来的login函数）
 */
async function login() {
  try {
    // 1. 编码账号密码（确保与手动访问一致）
    const encodedUser = encodeURIComponent(config.user);
    const encodedPass = encodeURIComponent(config.password);
    const loginUrl = `${config.apiUrl}/accounts/ClientLogin?Email=${encodedUser}&Passwd=${encodedPass}`;
    console.log('🔍 登录请求 URL:', loginUrl); // 对比与手动访问的URL是否一致

    // 2. 发送请求（添加浏览器模拟头，避免被识别为非浏览器请求）
    const response = await fetchWithRetry(loginUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    });

    // 3. 输出响应状态和原始内容（关键调试信息）
    console.log('📦 登录响应状态码:', response.status);
    const text = await response.text();
    console.log('📝 登录响应原始内容:', text); // 查看是否包含Auth=...

    // 4. 强化Auth提取逻辑（兼容换行、空格等情况）
    const authMatch = text.match(/Auth=(.+?)(\r\n|[\r\n]|$)/);
    if (authMatch && authMatch[1]) {
      const authToken = authMatch[1].trim();
      console.log('✅ 登录成功，Auth令牌:', authToken);
      return authToken;
    }

    // 5. 失败时详细提示
    console.error('❌ 未找到Auth令牌，响应内容:', text);
    return null;
  } catch (error) {
    console.error('❌ 登录请求异常:', error.message);
    return null;
  }
}

/**
 * 以下所有函数保持不变（与你之前的版本一致）
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
    
