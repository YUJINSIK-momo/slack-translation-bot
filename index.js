require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const FormData = require('form-data');

// Express 서버 사용
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// OpenAI 번역 호출 함수
async function translateText(text) {
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: "gpt-4",
      messages: [
        { role: "system", content: "Translate the following to Korean:" },
        { role: "user", content: text }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );
  return res.data.choices[0].message.content;
}

// 메시지 이벤트 처리
app.event('message', async ({ event, client, context }) => {
  try {
    if (event.subtype === 'bot_message') return; // 무한 루프 방지

    const text = event.text || '';
    const files = event.files || [];
    const translated = await translateText(text);

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*번역 결과:*\n${translated}`
        }
      }
    ];

    for (const file of files) {
      blocks.push({
        type: "image",
        image_url: file.url_private,
        alt_text: "첨부 이미지"
      });
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts, // 원본 메시지 스레드에 응답
      blocks,
      text: translated,
      token: context.botToken
    });

  } catch (error) {
    console.error('오류 발생:', error);
  }
});

// Slack URL verification 핸들러 추가
receiver.router.post('/slack/events', (req, res) => {
  if (req.body && req.body.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }
});

// 서버 실행
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ 번역봇 실행 중 - http://localhost:${port}`);
})();
