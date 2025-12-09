// Cloudflare Worker：Telegram 双向机器人 (v5.0 终极完整版)
// 功能：自动翻译 + 自动回复 + 人机验证 + 图集转发 + 黑名单管理

// ===================== 🛠️ 自定义配置区 (请在此修改) =====================

// 1. 自动翻译开关 (true: 开启, false: 关闭)
// 开启后：用户发外语 -> 翻译成中文发给您；您回中文 -> 翻译成英文发给用户
const ENABLE_TRANSLATE = true; 

// 2. 自动回复规则 (关键词 : 回复内容)
// 只要用户消息包含关键词（不区分大小写），机器人就会自动回复
const AUTO_REPLIES = {
    "你好": "😎 请稍等，我看到后会马上回复。",
    "在吗": "👋 在的，请稍等，我看到后会马上回复。",
    "多久": "💖 马上，马上，快了，宝贝儿！",
    "教程": "📖 请发送 /start 查看置顶教程。"
};

// ===================== 🛑 以下代码无需修改 =====================

// 本地验证题库
const LOCAL_QUESTIONS = [
    {"question": "冰融化后会变成什么？", "correct_answer": "水", "incorrect_answers": ["石头", "木头", "火"]},
    {"question": "正常人有几只眼睛？", "correct_answer": "2", "incorrect_answers": ["1", "3", "4"]},
    {"question": "1 加 2 等于几？", "correct_answer": "3", "incorrect_answers": ["2", "4", "5"]},
    {"question": "5 减 2 等于几？", "correct_answer": "3", "incorrect_answers": ["1", "2", "4"]},
    {"question": "在天上飞的交通工具是什么？", "correct_answer": "飞机", "incorrect_answers": ["汽车", "轮船", "自行车"]},
    {"question": "晴朗的天空通常是什么颜色的？", "correct_answer": "蓝色", "incorrect_answers": ["绿色", "红色", "紫色"]}
];

export default {
  async fetch(request, env, ctx) {
    // 环境检查
    if (!env.BOT_KV) return new Response("Error: KV 'BOT_KV' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.GROUP_ID) return new Response("Error: GROUP_ID not set.");

    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK");
    }

    // 处理回调 (验证码按钮)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 清理过期图集缓存
    ctx.waitUntil(flushExpiredMediaGroups(env));

    // 1. 处理私聊消息 (用户 -> 机器人)
    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, env, ctx);
      } catch (e) {
        console.error("Private Msg Error:", e);
      }
      return new Response("OK");
    }

    // 2. 处理群组消息 (管理员 -> 用户)
    const groupId = Number(env.GROUP_ID);
    if (msg.chat && Number(msg.chat.id) === groupId) {
        // 监听话题开关状态
        if (msg.forum_topic_closed && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, true, env);
            return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, false, env);
            return new Response("OK");
        }
        // 处理管理员回复
        if (msg.message_thread_id) {
            await handleAdminReply(msg, env, ctx);
            return new Response("OK");
        }
    }

    return new Response("OK");
  },
};

// ---------------- 核心逻辑：处理用户私聊 ----------------
async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 1. 过滤指令 (保留 /start)
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") return; 

  // 2. 检查黑名单
  const isBanned = await env.BOT_KV.get(`banned:${userId}`);
  if (isBanned) return; 

  // 3. 检查验证状态
  const verified = await env.BOT_KV.get(`verified:${userId}`);
  if (!verified) {
    const isStart = msg.text && msg.text.trim() === "/start";
    await sendVerificationChallenge(userId, env, isStart ? null : msg.message_id);
    return;
  }

  // 4. 自动回复逻辑
  if (msg.text) {
      for (const [keyword, reply] of Object.entries(AUTO_REPLIES)) {
          if (msg.text.toLowerCase().includes(keyword.toLowerCase())) {
              await tgCall(env, "sendMessage", { 
                  chat_id: userId, 
                  text: reply,
                  reply_to_message_id: msg.message_id 
              });
          }
      }
  }

  // 5. 转发逻辑
  await forwardToTopic(msg, userId, key, env, ctx);
}

// ---------------- 核心逻辑：转发到群组话题 ----------------
async function forwardToTopic(msg, userId, key, env, ctx) {
    let rec = await env.BOT_KV.get(key, { type: "json" });

    // 检查话题是否被关闭
    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }

    // 如果没话题，新建
    if (!rec || !rec.thread_id) {
        rec = await createTopic(msg.from, key, env);
    }

    // 翻译逻辑 (仅针对文本)
    let extraText = "";
    if (ENABLE_TRANSLATE && msg.text) {
        // 强制翻译成中文 (zh-CN) 给管理员看
        const trans = await googleTranslate(msg.text, "zh-CN");
        if (trans && trans.toLowerCase() !== msg.text.toLowerCase()) {
            extraText = `\n(译: ${trans})`;
        }
    }

    // 处理图集 (Media Group)
    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, { 
            direction: "p2t", 
            targetChat: env.GROUP_ID, 
            threadId: rec.thread_id 
        });
        return;
    }

    // 转发消息
    // 方案：先转发原消息，如果有翻译，再发一条翻译补充
    const res = await tgCall(env, "forwardMessage", {
        chat_id: env.GROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
    });

    // 错误处理 (话题丢失自动重建)
    if (!res.ok) {
        const desc = (res.description || "").toLowerCase();
        if (desc.includes("thread") || desc.includes("topic")) {
            const newRec = await createTopic(msg.from, key, env);
            await tgCall(env, "forwardMessage", {
                chat_id: env.GROUP_ID,
                from_chat_id: userId,
                message_id: msg.message_id,
                message_thread_id: newRec.thread_id,
            });
            // 更新 rec 以便后续发翻译
            rec = newRec; 
        } else if (desc.includes("chat not found")) {
            throw new Error(`群组ID错误: ${env.GROUP_ID}`);
        } else {
             // 降级为 Copy
             await tgCall(env, "copyMessage", {
                chat_id: env.GROUP_ID,
                from_chat_id: userId,
                message_id: msg.message_id,
                message_thread_id: rec.thread_id
            });
        }
    }

    // 发送翻译补充消息
    if (extraText) {
        await tgCall(env, "sendMessage", {
            chat_id: env.GROUP_ID,
            text: `📝 <b>翻译助手:</b>${extraText}`,
            message_thread_id: rec.thread_id,
            parse_mode: "HTML"
        });
    }
}

// ---------------- 核心逻辑：处理管理员回复 ----------------
async function handleAdminReply(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const text = (msg.text || "").trim();
  
  // 反查 UserId
  let userId = null;
  const list = await env.BOT_KV.list({ prefix: "user:" });
  for (const { name } of list.keys) {
      const rec = await env.BOT_KV.get(name, { type: "json" });
      if (rec && Number(rec.thread_id) === Number(threadId)) {
          userId = Number(name.slice(5)); 
          break;
      }
  }
  if (!userId) return; 

  // --- 管理员指令 ---
  if (text.startsWith("/")) {
      if (text === "/close") {
          const key = `user:${userId}`;
          let rec = await env.BOT_KV.get(key, { type: "json" });
          if (rec) {
              rec.closed = true;
              await env.BOT_KV.put(key, JSON.stringify(rec));
              await tgCall(env, "closeForumTopic", { chat_id: env.GROUP_ID, message_thread_id: threadId });
              await tgCall(env, "sendMessage", { chat_id: env.GROUP_ID, message_thread_id: threadId, text: "🚫 **对话已强制关闭**", parse_mode: "Markdown" });
          }
          return;
      }
      if (text === "/open") {
          const key = `user:${userId}`;
          let rec = await env.BOT_KV.get(key, { type: "json" });
          if (rec) {
              rec.closed = false;
              await env.BOT_KV.put(key, JSON.stringify(rec));
              await tgCall(env, "reopenForumTopic", { chat_id: env.GROUP_ID, message_thread_id: threadId });
              await tgCall(env, "sendMessage", { chat_id: env.GROUP_ID, message_thread_id: threadId, text: "✅ **对话已恢复**", parse_mode: "Markdown" });
          }
          return;
      }
      if (text === "/ban") {
          await env.BOT_KV.put(`banned:${userId}`, "1");
          await tgCall(env, "sendMessage", { chat_id: env.GROUP_ID, message_thread_id: threadId, text: "🚫 **用户已封禁**", parse_mode: "Markdown" });
          return;
      }
      if (text === "/unban") {
          await env.BOT_KV.delete(`banned:${userId}`);
          await tgCall(env, "sendMessage", { chat_id: env.GROUP_ID, message_thread_id: threadId, text: "✅ **用户已解封**", parse_mode: "Markdown" });
          return;
      }
      if (text === "/info") {
          const info = `👤 **用户:** \`${userId}\`\n🔗 [点击私聊](tg://user?id=${userId})`;
          await tgCall(env, "sendMessage", { chat_id: env.GROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
          return;
      }
      if (text === "/reset") {
          await env.BOT_KV.delete(`verified:${userId}`);
          await tgCall(env, "sendMessage", { chat_id: env.GROUP_ID, message_thread_id: threadId, text: "🔄 **验证已重置**", parse_mode: "Markdown" });
          return;
      }
  }

  // --- 管理员回复逻辑 (含翻译) ---
  
  let replyContent = text;
  
  // 翻译逻辑：如果管理员发中文，尝试翻译成英文
  if (ENABLE_TRANSLATE && text && /[\u4e00-\u9fa5]/.test(text)) {
      const trans = await googleTranslate(text, "en"); // 目标语言：英文
      if (trans) {
          replyContent = `${text}\n\n🇬🇧 ${trans}`;
      }
  }

  // 图集直接转发
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: null });
    return;
  }

  // 如果有文本变化（翻译了），用 sendMessage
  if (replyContent !== text) {
      await tgCall(env, "sendMessage", { chat_id: userId, text: replyContent });
  } else {
      // 否则用 Copy (支持图片、表情包等)
      await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.GROUP_ID, message_id: msg.message_id });
  }
}

// ---------------- 谷歌翻译 (免费接口) ----------------
async function googleTranslate(text, targetLang) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) return null;
        const data = await res.json();
        // data[0] 是翻译结果数组
        return data[0].map(x => x[0]).join("");
    } catch (e) {
        return null;
    }
}

// ---------------- 图集处理 (Media Group) ----------------
async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
        // 非支持媒体，直接 Copy
        await tgCall(env, "copyMessage", { chat_id: targetChat, from_chat_id: msg.chat.id, message_id: msg.message_id, message_thread_id: threadId });
        return;
    }
    
    // 读缓存
    let rec = await env.BOT_KV.get(key, { type: "json" });
    if (!rec) rec = { direction, targetChat, threadId, items: [], last_ts: Date.now() };
    
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    
    // 存缓存 (60秒过期)
    await env.BOT_KV.put(key, JSON.stringify(rec), { expirationTtl: 60 });
    
    // 延迟发送 (等待所有图片到齐)
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, 2000)); // 等 2 秒
    const rec = await env.BOT_KV.get(key, { type: "json" });
    // 只有时间戳匹配才发送 (防止多次发送)
    if (rec && rec.last_ts === ts) {
        // 构造 MediaGroup
        const media = rec.items.map((it, i) => ({ 
            type: it.type, 
            media: it.id, 
            caption: i===0 ? it.cap : "" // 只在第一张图保留标题
        }));
        
        if (media.length > 0) {
            await tgCall(env, "sendMediaGroup", { 
                chat_id: rec.targetChat, 
                message_thread_id: rec.threadId, 
                media 
            });
        }
        await env.BOT_KV.delete(key);
    }
}

function extractMedia(msg) {
    if (msg.photo) return { type: "photo", id: msg.photo.pop().file_id, cap: msg.caption };
    if (msg.video) return { type: "video", id: msg.video.file_id, cap: msg.caption };
    if (msg.document) return { type: "document", id: msg.document.file_id, cap: msg.caption };
    return null;
}
async function flushExpiredMediaGroups(env) {} // 占位符

// ---------------- 验证模块 ----------------
async function sendVerificationChallenge(userId, env, pendingMsgId) {
    const q = LOCAL_QUESTIONS[Math.floor(Math.random() * LOCAL_QUESTIONS.length)];
    const challenge = {
        question: q.question,
        correct: q.correct_answer,
        options: shuffleArray([...q.incorrect_answers, q.correct_answer])
    };
    const verifyId = Math.random().toString(36).substring(2, 10);
    const state = { ans: challenge.correct, pending: pendingMsgId };
    
    await env.BOT_KV.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: 300 });

    const buttons = challenge.options.map(opt => ({ 
        text: opt, 
        callback_data: `verify:${verifyId}:${opt.substring(0,20)}` 
    }));
    
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));

    await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: `🛡️ **人机验证**\n\n${challenge.question}\n\n(回答正确后将自动发送您的消息)`,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function handleCallbackQuery(query, env, ctx) {
    try {
        const data = query.data;
        if (!data.startsWith("verify:")) return;
        const parts = data.split(":");
        if (parts.length < 3) return;
        const verifyId = parts[1];
        const userAns = parts.slice(2).join(":"); 
        const userId = query.from.id;

        const stateStr = await env.BOT_KV.get(`chal:${verifyId}`);
        if (!stateStr) {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "❌ 验证过期，请重发消息", show_alert: true });
            return;
        }
        const state = JSON.parse(stateStr);
        if (userAns === state.ans) {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "✅ 验证通过" });
            await env.BOT_KV.put(`verified:${userId}`, "1", { expirationTtl: 2592000 }); // 30天免验证
            await env.BOT_KV.delete(`chal:${verifyId}`);
            await tgCall(env, "editMessageText", { chat_id: userId, message_id: query.message.message_id, text: "✅ **验证成功，您可以开始对话了**", parse_mode: "Markdown" });
            
            // 补发刚才拦截的消息
            if (state.pending) {
                 await tgCall(env, "sendMessage", { chat_id: userId, text: "📩 刚才的消息已帮您自动送达。", reply_to_message_id: state.pending });
                 // 构造假消息触发转发
                 const fakeMsg = { 
                     message_id: state.pending, 
                     chat: { id: userId, type: "private" }, 
                     from: query.from, 
                     text: "(用户通过验证后补发)" 
                 };
                 await handlePrivateMessage(fakeMsg, env, ctx);
            }
        } else {
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "❌ 错误，请重试", show_alert: true });
        }
    } catch(e) {}
}

// ---------------- 工具函数 ----------------
async function createTopic(from, key, env) {
    const title = (from.first_name + " " + (from.last_name || "")).trim() || "User";
    if (!env.GROUP_ID.toString().startsWith("-100")) throw new Error("GROUP_ID格式错误");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.GROUP_ID, name: title });
    if (!res.ok) throw new Error(res.description);
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.BOT_KV.put(key, JSON.stringify(rec));
    return rec;
}

function updateThreadStatus(threadId, isClosed, env) {
    env.BOT_KV.list({ prefix: "user:" }).then(list => {
        for (const { name } of list.keys) {
            env.BOT_KV.get(name, { type: "json" }).then(rec => {
                if (rec && Number(rec.thread_id) === Number(threadId)) {
                    rec.closed = isClosed;
                    env.BOT_KV.put(name, JSON.stringify(rec));
                }
            });
        }
    });
}

function shuffleArray(arr) { return arr.sort(() => Math.random() - 0.5); }

async function tgCall(env, method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await resp.json();
}
