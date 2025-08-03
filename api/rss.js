const { getRssArticles } = require('../utils/rssHandler');

module.exports = async (req, res) => {
  // 设置CORS（替换为你的服务器域名）
  res.setHeader('Access-Control-Allow-Origin', 'https://rss2.dao.js.cn');
  res.setHeader('Content-Type', 'application/json');

  try {
    // 捕获所有可能的异常
    const articles = await getRssArticles();
    res.status(200).json(articles);
  } catch (error) {
    // 输出详细错误到日志，同时返回友好信息
    console.error('函数执行异常:', error);
    res.status(500).json({ 
      error: '服务器内部错误', 
      details: process.env.NODE_ENV === 'development' ? error.message : '请稍后重试' 
    });
  }
};
