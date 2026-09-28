import express from 'express';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 8001;
const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://backend:3000';

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'bots' });
});

app.post('/notify/feishu', async (req, res) => {
  try {
    const { title, content } = req.body;
    const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(500).json({ error: 'FEISHU_WEBHOOK_URL not configured' });
    }
    await axios.post(webhookUrl, {
      msg_type: 'interactive',
      card: {
        header: { title: { content: title, tag: 'plain_text' } },
        elements: [{ tag: 'markdown', content }],
      },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/notify/dingtalk', async (req, res) => {
  try {
    const { title, content } = req.body;
    const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(500).json({ error: 'DINGTALK_WEBHOOK_URL not configured' });
    }
    await axios.post(webhookUrl, {
      msgtype: 'markdown',
      markdown: { title, text: content },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[bots] listening on :${PORT}`);
});
