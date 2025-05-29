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

// 입력이 한국어인지 판별하는 함수
function isKorean(text) {
  return /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(text);
}

// OpenAI 번역 호출 함수
async function translateText(text, targetLang) {
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: "gpt-4",
      messages: [
        { role: "system", content: `Translate the following to ${targetLang}:` },
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
app.event('message', async ({ event, client, context, say }) => {
  try {
    if (event.subtype === 'bot_message') return; // 무한 루프 방지

    const text = event.text || '';
    const files = event.files || [];
    const lines = text.split('\n');
    const teamName = lines[0] || '-';
    const logoRequest = lines[1] || '-';
    const pantsRequest = lines[2] || '-';

    // 번역 대상 언어 결정
    const targetLang = isKorean(text) ? "English" : "Korean";

    // 각 줄 번역
    const [teamNameT, logoRequestT, pantsRequestT] = await Promise.all([
      translateText(teamName, targetLang),
      translateText(logoRequest, targetLang),
      translateText(pantsRequest, targetLang)
    ]);

    // 카드형 Block Kit 메시지 생성
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*팀명:* ${teamNameT}\n*로고 요청사항:* ${logoRequestT}\n*바지 요청사항:* ${pantsRequestT}`
        }
      },
      ...files.map(file => ({
        type: "image",
        image_url: file.url_private,
        alt_text: "첨부 이미지"
      })),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "디자인 확인! 👀"
            },
            action_id: "confirm_design"
          }
        ]
      }
    ];

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts, // 원본 메시지 스레드에 응답
      blocks,
      text: `${teamNameT} / ${logoRequestT} / ${pantsRequestT}`,
      token: context.botToken
    });

  } catch (error) {
    console.error('오류 발생:', error);
  }
});

// 버튼 클릭 인터랙션 처리
app.action('confirm_design', async ({ ack, body, client, context }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.ts,
    text: '디자인 확인 완료! ✅',
    token: context.botToken
  });
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
