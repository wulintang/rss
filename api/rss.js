// Vercel Serverless 函数入口
const { getRssArticles } = require('../utils/rssHandler');

module.exports = async (req, res) => {
  // 设置CORS，允许你的服务器访问
  res.setHeader('Access-Control-Allow-Origin', 'https://rss2.dao.js.cn');
  res.setHeader('Content-Type', 'application/json');

  try {
    const articles = await getRssArticles();
    res.status(200).json(articles);
  } catch (error) {
    res.status(500).json({ error: '获取 RSS 数据失败', message: error.message });
  }
};
    
