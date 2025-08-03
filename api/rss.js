const { getRssArticles } = require('../utils/rssHandler');

// 全局超时保护（防止函数无响应）
const MAX_EXECUTION_TIME = 290000; // 290秒，留10秒缓冲

module.exports = async (req, res) => {
  // 设置CORS（替换为你的服务器域名）
  res.setHeader('Access-Control-Allow-Origin', 'https://rss2.dao.js.cn');
  res.setHeader('Content-Type', 'application/json');

  // 超时保护
  const timeoutId = setTimeout(() => {
    console.error('API响应超时');
    res.status(504).json({ 
      error: '处理超时', 
      message: '数据处理时间过长，请稍后重试',
      cached: !!cache.data,
      data: cache.data || null // 超时也返回已有缓存
    });
  }, MAX_EXECUTION_TIME);

  try {
    const articles = await getRssArticles();
    clearTimeout(timeoutId); // 清除超时
    res.status(200).json(articles);
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('函数执行异常:', error);
    res.status(500).json({ 
      error: '服务器内部错误', 
      details: error.message,
      cached: !!cache.data,
      data: cache.data || null // 出错也返回缓存
    });
  }
};
    
