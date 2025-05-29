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

// 개선된 입력 파싱 함수 (공백/들여쓰기 무시)
function parseSections(text) {
  const lines = text.split('\n');
  let team = '', main = '', detail = '';
  let current = null;

  for (let line of lines) {
    const trimmed = line.trim();
    if (/^팀명:/.test(trimmed)) {
      current = 'team';
      team += trimmed.replace(/^팀명:/, '').trim();
    } else if (/^주요 요청사항:/.test(trimmed)) {
      current = 'main';
      main += trimmed.replace(/^주요 요청사항:/, '').trim();
    } else if (/^세부 요청사항:/.test(trimmed)) {
      current = 'detail';
      detail += trimmed.replace(/^세부 요청사항:/, '').trim();
    } else if (trimmed) {
      if (current === 'team') team += (team ? '\n' : '') + trimmed;
      else if (current === 'main') main += (main ? '\n' : '') + trimmed;
      else if (current === 'detail') detail += (detail ? '\n' : '') + trimmed;
    }
  }
  return { team: team.trim(), main: main.trim(), detail: detail.trim() };
}

// 메시지 이벤트 처리
app.event('message', async ({ event, client, context, say }) => {
  try {
    if (event.subtype === 'bot_message') return; // 무한 루프 방지

    const text = event.text || '';
    const files = event.files || [];
    const { team, main, detail } = parseSections(text);

    // 양식 체크: 세 항목이 모두 있을 때만 카드, 아니면 전체 번역만
    const isForm = team && main && detail;
    const targetLang = isKorean(text) ? "English" : "Korean";

    if (isForm) {
      // 팀명은 번역하지 않고 그대로 사용
      const [mainT, detailT] = await Promise.all([
        translateText(main, targetLang),
        translateText(detail, targetLang)
      ]);

      // 카드형 Block Kit 메시지 생성 (UI 개선, 버튼 제거)
      const blocks = [
        {
          type: "header",
          text: { type: "plain_text", text: `⚽ Team Name: ${team}` }
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Main Requests:*
${mainT.split('\n').map(line => `• ${line}`).join('\n')}`
          }
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Detailed Requests:*
${detailT.split('\n').map(line => `• ${line}`).join('\n')}`
          }
        },
        ...files.map(file => ({
          type: "image",
          image_url: file.url_private,
          alt_text: "Attached Image"
        }))
      ];

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts, // 원본 메시지 스레드에 응답
        blocks,
        text: `Team Name: ${team} / ${mainT} / ${detailT}`,
        token: context.botToken
      });
    } else {
      // 양식이 아니면 전체 메시지 번역만
      const translated = await translateText(text, targetLang);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: translated,
        token: context.botToken
      });
    }
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
