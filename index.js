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

// 특정 단어를 빨간색으로 강조하는 함수
function highlightWord(text, word) {
  return text.replace(new RegExp(word, 'g'), `*${word}*`);
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

// [신규], [수정] 감지 및 영어 변환 함수
function parseHeader(text) {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine === '【신규】') return '【NEW】';
  if (firstLine === '【수정】') return '【EDIT】';
  return '';
}

// 개선된 입력 파싱 함수 (라벨 뒤 같은 줄 텍스트도 포함)
function parseSections(text) {
  const lines = text.split('\n');
  let team = '', main = '', detail = '';
  let current = null;

  for (let line of lines) {
    const trimmed = line.trim();
    // 헤더 라인은 건너뛰기
    if (trimmed === '【신규】' || trimmed === '【수정】') continue;
    
    if (trimmed.startsWith('팀명:')) {
      current = 'team';
      team = trimmed.replace(/^팀명:/, '').trim();
    } else if (trimmed.startsWith('디자인 요청사항:')) {
      current = 'main';
      main = trimmed.replace(/^디자인 요청사항:/, '').trim();
    } else if (trimmed.startsWith('이미지 요청사항:')) {
      current = 'detail';
      detail = trimmed.replace(/^이미지 요청사항:/, '').trim();
    } else if (current === 'main' && trimmed) {
      main += (main ? '\n' : '') + trimmed;
    } else if (current === 'detail' && trimmed) {
      detail += (detail ? '\n' : '') + trimmed;
    }
  }
  return { team: team.trim(), main: main.trim(), detail: detail.trim() };
}

// 번역 전, 빈 줄은 제외하고 숫자만 있는 줄은 그대로, 나머지만 번역
async function translateLinesPreserveNumbers(lines, targetLang) {
  const filtered = lines.filter(line => line.trim() !== '');
  return Promise.all(
    filtered.map(async (line) => {
      // 숫자만 있는 줄이거나 특정 단어가 포함된 줄은 그대로 유지
      if (/^\d+$/.test(line.trim()) || line.includes('유진식')) {
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
    // 번역과 무관한 이벤트는 무시
    if (
      event.subtype === 'bot_message' ||
      event.subtype === 'message_changed' ||
      event.subtype === 'message_deleted' ||
      event.subtype === 'file_share' ||
      !event.text
    ) return;

    console.log('메시지 수신:', event.text); // 디버깅 로그

    const text = event.text || '';
    const files = event.files || [];
    
    // 헤더 제거 로직 수정
    let bodyText = text;
    const header = parseHeader(text);
    if (header) {
      bodyText = text.split('\n').slice(1).join('\n').trim();
    }
    
    const { team, main, detail } = parseSections(bodyText);
    console.log('파싱된 양식:', { team, main, detail }); // 디버깅 로그

    // 양식 체크: 세 항목 중 하나라도 있으면 카드, 모두 비어 있으면 전체 번역만
    const isForm = team !== '' || main !== '' || detail !== '';
    console.log('양식 여부:', isForm); // 디버깅 로그

    const targetLang = isKorean(text) ? "English" : "Korean";
    console.log('번역 방향:', targetLang); // 디버깅 로그

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

      // 특정 단어가 포함된 줄은 번역하지 않고 빨간색으로 강조
      const highlightedMainList = mainList.map(line => {
        if (line.includes('유진식')) {
          return highlightWord(line, '유진식');
        }
        return line;
      });

      const highlightedDetailList = detailList.map(line => {
        if (line.includes('유진식')) {
          return highlightWord(line, '유진식');
        }
        return line;
      });

      // 현재 시간을 한국 시간으로 변환
      const now = new Date();
      const koreaTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
      const formattedDate = koreaTime.toLocaleString('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });

      // 카드형 Block Kit 메시지 생성 (UI 개선)
      const blocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `${header || '【NEW】'} Design Request Form`,
            emoji: true
          }
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*🏆 Team Name*\n${team}`
            },
            {
              type: "mrkdwn",
              text: `*📅 Request Date*\n${formattedDate}`
            }
          ]
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*🎨 Design Requests*\n${highlightedMainList.length > 0 ? highlightedMainList.map(line => `• ${line}`).join('\n') : '_No design requests_'}`
          },
          accessory: {
            type: "image",
            image_url: "https://api.slack.com/img/blocks/bkb_template_images/design.png",
            alt_text: "Design icon"
          }
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*🖼️ Image Requests*\n${highlightedDetailList.length > 0 ? highlightedDetailList.map(line => `• ${line}`).join('\n') : '_No image requests_'}`
          },
          accessory: {
            type: "image",
            image_url: "https://api.slack.com/img/blocks/bkb_template_images/image.png",
            alt_text: "Image icon"
          }
        },
        ...files.map(file => ({
          type: "image",
          image_url: file.url_private,
          alt_text: "Attached Image"
        })),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👀 Pending Review",
                emoji: true
              },
              style: "primary",
              action_id: "status_pending"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "⚡ In Progress",
                emoji: true
              },
              style: "primary",
              action_id: "status_in_progress"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Completed",
                emoji: true
              },
              style: "primary",
              action_id: "status_completed"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "⚠️ Needs Revision",
                emoji: true
              },
              style: "danger",
              action_id: "status_needs_revision"
            }
          ]
        },
        // 상태 강조 블록 (초기값: Pending Review)
        {
          type: "section",
          block_id: "status_section",
          text: {
            type: "mrkdwn",
            text: `*Status:*
*👀 Pending Review*`
          }
        },
        // 작업자 context 블록 (초기값: 요청자)
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*작업자:* <@${event.user}>`
            }
          ]
        }
      ];

      // 메인 채널에 메시지 전송
      const result = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        blocks,
        text: `${header ? header + ' ' : ''}Team Name: ${team} / ${main} / ${detail}`,
        token: context.botToken
      });

      // 아카이브 채널에 저장 (환경 변수에서 채널 ID를 가져옴)
      if (process.env.ARCHIVE_CHANNEL_ID) {
        await client.chat.postMessage({
          channel: process.env.ARCHIVE_CHANNEL_ID,
          blocks: blocks,
          text: `${header ? header + ' ' : ''}Team Name: ${team} / ${main} / ${detail}`,
          token: context.botToken
        });
      }
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

// 각 상태 버튼 핸들러에서 block_id로 상태 section을 찾아 업데이트
function updateStatusBlock(blocks, statusText) {
  const statusBlock = blocks.find(b => b.block_id === 'status_section');
  if (statusBlock) {
    statusBlock.text.text = statusText;
  }
}

// 버튼 클릭 인터랙션 처리
app.action('status_pending', async ({ ack, body, client, context }) => {
  await ack();
  console.log('[status_pending] action triggered');
  console.log('channel:', body.channel.id, 'ts:', body.message.ts);
  console.log('작성자 user:', body.message.user);
  try {
    const blocks = body.message.blocks;
    updateStatusBlock(blocks, `*Status:*\n*👀 Pending Review*`);
    blocks[blocks.length-1].elements[0].text = `*작업자:* <@${body.user.id}>`;
    await client.chat.update({ 
      channel: body.channel.id, 
      ts: body.message.ts, 
      blocks: blocks, 
      text: "Design Request Form - Status: Pending Review",
      token: context.botToken 
    });
  } catch (error) {
    console.error('[status_pending] 상태 변경 중 오류:', error.data || error);
  }
});

app.action('status_in_progress', async ({ ack, body, client, context }) => {
  await ack();
  console.log('[status_in_progress] action triggered');
  console.log('channel:', body.channel.id, 'ts:', body.message.ts);
  console.log('작성자 user:', body.message.user);
  try {
    const blocks = body.message.blocks;
    updateStatusBlock(blocks, `*Status:*\n*⚡ In Progress*`);
    blocks[blocks.length-1].elements[0].text = `*작업자:* <@${body.user.id}>`;
    await client.chat.update({ 
      channel: body.channel.id, 
      ts: body.message.ts, 
      blocks: blocks, 
      text: "Design Request Form - Status: In Progress",
      token: context.botToken 
    });
  } catch (error) {
    console.error('[status_in_progress] 상태 변경 중 오류:', error.data || error);
  }
});

app.action('status_completed', async ({ ack, body, client, context }) => {
  await ack();
  console.log('[status_completed] action triggered');
  console.log('channel:', body.channel.id, 'ts:', body.message.ts);
  console.log('작성자 user:', body.message.user);
  try {
    const blocks = body.message.blocks;
    updateStatusBlock(blocks, `*Status:*\n*✅ Completed*`);
    blocks[blocks.length-1].elements[0].text = `*작업자:* <@${body.user.id}>`;
    await client.chat.update({ 
      channel: body.channel.id, 
      ts: body.message.ts, 
      blocks: blocks, 
      text: "Design Request Form - Status: Completed",
      token: context.botToken 
    });
  } catch (error) {
    console.error('[status_completed] 상태 변경 중 오류:', error.data || error);
  }
});

app.action('status_needs_revision', async ({ ack, body, client, context }) => {
  await ack();
  console.log('[status_needs_revision] action triggered');
  console.log('channel:', body.channel.id, 'ts:', body.message.ts);
  console.log('작성자 user:', body.message.user);
  try {
    const blocks = body.message.blocks;
    updateStatusBlock(blocks, `*Status:*\n*⚠️ Needs Revision*`);
    blocks[blocks.length-1].elements[0].text = `*작업자:* <@${body.user.id}>`;
    await client.chat.update({ 
      channel: body.channel.id, 
      ts: body.message.ts, 
      blocks: blocks, 
      text: "Design Request Form - Status: Needs Revision",
      token: context.botToken 
    });
  } catch (error) {
    console.error('[status_needs_revision] 상태 변경 중 오류:', error.data || error);
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
