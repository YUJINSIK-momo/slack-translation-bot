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

// 특정 단어 감지 및 고정 응답 함수
function checkFixedResponse(text) {
  const fixedResponses = {
    '유진식': '유진식을테스트로입력한거지만고정으로나오게해드리겠습니다.'
  };
  
  for (const [keyword, response] of Object.entries(fixedResponses)) {
    if (text.includes(keyword)) {
      return response;
    }
  }
  return null;
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

// 개선된 입력 파싱 함수 (라벨 뒤 같은 줄 텍스트도 포함)
function parseSections(text) {
  const lines = text.split('\n');
  let team = '', main = '', detail = '';
  let current = null;

  for (let line of lines) {
    const trimmed = line.trim();
    if (/^팀명:/.test(trimmed)) {
      current = 'team';
      team = trimmed.replace(/^팀명:/, '').trim();
    } else if (/^디자인 요청사항:/.test(trimmed)) {
      current = 'main';
      main = trimmed.replace(/^디자인 요청사항:/, '').trim();
    } else if (/^이미지 요청사항:/.test(trimmed)) {
      current = 'detail';
      detail = trimmed.replace(/^이미지 요청사항:/, '').trim();
    } else if (current === 'main') {
      main += (main ? '\n' : '') + trimmed;
    } else if (current === 'detail') {
      detail += (detail ? '\n' : '') + trimmed;
    }
  }
  return { team: team.trim(), main: main.trim(), detail: detail.trim() };
}

// [신규], [수정] 감지 및 영어 변환 함수
function parseHeader(text) {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine === '【신규】') return '【NEW】';
  if (firstLine === '【수정】') return '【EDIT】';
  return '';
}

// 번역 전, 빈 줄은 제외하고 숫자만 있는 줄은 그대로, 나머지만 번역
async function translateLinesPreserveNumbers(lines, targetLang) {
  const filtered = lines.filter(line => line.trim() !== '');
  return Promise.all(
    filtered.map(async (line) => {
      // 숫자만 있는 줄이거나 특정 단어가 포함된 줄은 그대로 유지
      if (/^\d+$/.test(line.trim()) || checkFixedResponse(line)) {
        return line;
      } else {
        return await translateText(line, targetLang);
      }
    })
  );
}

// 메시지 이벤트 처리
app.event('message', async ({ event, client, context, say }) => {
  try {
    if (event.subtype === 'bot_message') return; // 무한 루프 방지

    const text = event.text || '';
    const files = event.files || [];
    
    // 헤더([신규], [수정] 등) 제거 후 남은 텍스트의 첫 줄이 빈 줄이면 삭제
    let bodyText = text.replace(/^\[.*?\]\s*/, '');
    if (bodyText.startsWith('\n')) bodyText = bodyText.slice(1);
    const { team, main, detail } = parseSections(bodyText.trim());

    // 양식 체크: 세 항목 중 하나라도 있으면 카드, 모두 비어 있으면 전체 번역만
    const isForm = team !== '' || main !== '' || detail !== '';
    const targetLang = isKorean(text) ? "English" : "Korean";

    // 고정 응답 체크 및 리액션 추가
    const fixedResponse = checkFixedResponse(text);
    if (fixedResponse) {
      // 고정 응답 메시지 전송
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: fixedResponse,
        token: context.botToken
      });

      // 양식이면 "검토중" 리액션 추가
      if (isForm) {
        await client.reactions.add({
          channel: event.channel,
          timestamp: event.ts,
          name: 'hourglass_flowing_sand', // ⏳ 이모지
          token: context.botToken
        });
      }
    }

    if (isForm) {
      // 팀명은 번역하지 않고 그대로 사용
      // 주요/세부 요청사항 각 줄별로 숫자만 있는 줄은 번역하지 않음, 빈 줄은 제외
      const mainLines = main.split('\n');
      const detailLines = detail.split('\n');
      const [mainTArr, detailTArr] = await Promise.all([
        translateLinesPreserveNumbers(mainLines, targetLang),
        translateLinesPreserveNumbers(detailLines, targetLang)
      ]);
      const mainList = mainTArr.filter(line => line.trim() !== '');
      const detailList = detailTArr.filter(line => line.trim() !== '');

      // 카드형 Block Kit 메시지 생성
      const blocks = [
        ...(parseHeader(text) ? [
          {
            type: "header",
            text: { type: "plain_text", text: `${parseHeader(text)}` }
          },
          {
            type: "header",
            text: { type: "plain_text", text: `⚽ Team Name: ${team}` }
          }
        ] : [
          {
            type: "header",
            text: { type: "plain_text", text: `⚽ Team Name: ${team}` }
          }
        ]),
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Design Requests:*
${mainList.length > 0 ? mainList.map(line => `• ${line}`).join('\n') : ''}`
          }
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Image Requests:*
${detailList.length > 0 ? detailList.map(line => `• ${line}`).join('\n') : ''}`
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
        thread_ts: event.ts,
        blocks,
        text: `${parseHeader(text) ? parseHeader(text) + ' ' : ''}Team Name: ${team} / ${main} / ${detail}`,
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
  
  // "검토중" 리액션 제거
  await client.reactions.remove({
    channel: body.channel.id,
    timestamp: body.message.ts,
    name: 'hourglass_flowing_sand',
    token: context.botToken
  });

  // "완료" 리액션 추가
  await client.reactions.add({
    channel: body.channel.id,
    timestamp: body.message.ts,
    name: 'heavy_check_mark', // ✔️ 이모지
    token: context.botToken
  });

  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.ts,
    text: '디자인 확인 완료! ✔️',
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
