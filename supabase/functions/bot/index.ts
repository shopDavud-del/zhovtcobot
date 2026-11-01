// deno-lint-ignore-file no-explicit-any
// Telegram shop bot · Supabase Edge Function (Deno) · grammY
import { Bot, Context, InlineKeyboard, InputFile, Keyboard, webhookCallback } from "npm:grammy@1.30.0";
import { createClient } from "npm:@supabase/supabase-js@2";

/* ============================ config ============================ */
const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const ADMIN_GROUP = Number(env("ADMIN_GROUP_ID"));
const CHANNEL = env("CHANNEL_ID");
const BOT_USERNAME = env("BOT_USERNAME").replace("@", "");
const PREPAY = Number(env("PREPAY_PERCENT", "50"));
const CAPACITY = Number(env("DAILY_CAPACITY", "3"));
const TZ = Number(env("TZ_OFFSET_HOURS", "5"));
const CARD_NUMBER = env("CARD_NUMBER");
const CARD_HOLDER = env("CARD_HOLDER");
const QR_URL = env("QR_URL");
const CLICK_TOKEN = env("CLICK_PROVIDER_TOKEN");
const DELETE_AFTER_ARCHIVE = env("DELETE_TOPIC_AFTER_ARCHIVE") === "true";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const bot = new Bot(env("BOT_TOKEN"));
bot.catch((e) => console.error("bot error:", e.error));

/* ============================ helpers ============================ */
const esc = (s: any) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: any) =>
  n == null ? "—" : Math.round(Number(n)).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ");
const num = (s: string) => {
  const n = Number(String(s).replace(/[^\d]/g, ""));
  return n > 0 ? n : 0;
};
const titleOf = (p: any) => p.title || `Модель №${p.id}`;

// даты считаем в часовом поясе магазина (TZ_OFFSET_HOURS)
const nowTz = () => new Date(Date.now() + TZ * 3600e3);
const todayStr = () => nowTz().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dRu = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const dtRu = (iso: string) =>
  new Date(new Date(iso).getTime() + TZ * 3600e3).toLocaleString("ru-RU", {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
const atTz = (day: string, h: number, m = 0) => {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - TZ, m));
};
function parseWhen(t: string): Date | null {
  const m = t.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const y = m[3] ? +m[3] : nowTz().getUTCFullYear();
  let dt = new Date(Date.UTC(y, +m[2] - 1, +m[1], +m[4] - TZ, +m[5]));
  if (!m[3] && dt.getTime() < Date.now()) dt = new Date(Date.UTC(y + 1, +m[2] - 1, +m[1], +m[4] - TZ, +m[5]));
  return isNaN(+dt) ? null : dt;
}

const getSet = async (k: string) =>
  (await db.from("settings").select("value").eq("key", k).maybeSingle()).data?.value as string | undefined;
const setSet = (k: string, v: string) => db.from("settings").upsert({ key: k, value: v });

// диалоговое состояние (хранится в БД, функция без памяти)
type S = { step?: string; data?: Record<string, any> };
const skey = (ctx: Context) => `${ctx.chat?.type === "private" ? "p" : "g"}:${ctx.from!.id}`;
async function getS(ctx: Context): Promise<S> {
  const { data } = await db.from("sessions").select("data").eq("key", skey(ctx)).maybeSingle();
  return (data?.data as S) ?? {};
}
const setS = (ctx: Context, s: S) =>
  db.from("sessions").upsert({ key: skey(ctx), data: s, updated_at: new Date().toISOString() });
const clearS = (ctx: Context) => setS(ctx, {});

async function send(thread: "products" | "ideas" | "archive" | null, text: string, extra: any = {}) {
  const t = thread ? Number(await getSet(thread)) : 0;
  return bot.api.sendMessage(ADMIN_GROUP, text, {
    parse_mode: "HTML",
    ...(t ? { message_thread_id: t } : {}),
    ...extra,
  });
}
const logMsg = (order_id: number, direction: string, author: string | null, text?: string | null, file_id?: string | null, file_kind?: string | null) =>
  db.from("messages").insert({ order_id, direction, author, text: text ?? null, file_id: file_id ?? null, file_kind: file_kind ?? null });

const mainKb = new Keyboard().text("🛒 Заказать").resized().persistent();

/* ============================ товары: оформление поста ============================ */
const postCaption = (p: any) =>
  `<b>${esc(titleOf(p))}</b>\n\n💰 Цена: <b>${money(p.price)} сум</b>\n⏱ Срок: ${p.term_days} дн.`;
const deepLink = (id: number) => `https://t.me/${BOT_USERNAME}?start=m_${id}`;
const postKb = (id: number) => new InlineKeyboard().url("🛒 Заказать", deepLink(id));

async function publishProduct(id: number) {
  const { data: p } = await db.from("products").select("*").eq("id", id).single();
  if (!p) return;
  const m = await bot.api.sendPhoto(CHANNEL, p.photos[0], {
    caption: postCaption(p), parse_mode: "HTML", reply_markup: postKb(p.id),
  });
  await db.from("products").update({ status: "published", channel_msg_id: m.message_id }).eq("id", id);
  return m;
}

/* ============================ заказы: карточка и темы ============================ */
const ICON: Record<string, string> = {
  await_price: "💬", await_payment: "⏳", await_receipt: "🧾", paid: "✅", in_work: "🛠",
  ready: "📦", shipped: "🚚", done: "🏁", cancelled: "❌", expired: "❌",
};
const STATUS: Record<string, string> = {
  await_price: "ждёт цену", await_payment: "ждёт оплаты", await_receipt: "ждёт чек", paid: "оплачено",
  in_work: "в работе", ready: "готово, ждём остаток", shipped: "отправлено", done: "завершён",
  cancelled: "отменён", expired: "бронь истекла",
};
const regionLabel = (o: any) => (o.region === "t" ? "Ташкент/область → Яндекс" : "Другой регион → СДЭК/местная");
const topicName = (o: any) =>
  `${ICON[o.status] ?? ""} #${o.id} ${o.client_name ?? ""} · ${o.custom ? "свой вариант" : o.model_title ?? ""}`.slice(0, 120);

function card(o: any) {
  const status = o.status === "await_receipt" && o.receipt_sent ? "чек на проверке" : STATUS[o.status];
  return [
    `<b>Заказ #${o.id}</b> · ${status}`,
    `👤 ${esc(o.client_name)}${o.username ? ` (@${esc(o.username)})` : ""} · ${esc(o.phone)}`,
    `📦 ${esc(o.model_title ?? "Свой вариант")}${o.custom_note ? `\n📝 ${esc(o.custom_note)}` : ""}`,
    o.price
      ? `💰 ${money(o.price)} сум · предоплата ${money(o.prepay)} · срок ${o.term_days} дн.`
      : "💰 цена не назначена",
    `📍 ${regionLabel(o)}: ${esc(o.address)}`,
    o.pay_method ? `💳 ${o.pay_method === "click" ? "Click (авто)" : "Карта (проверить чек)"}` : null,
    o.start_date ? `📅 Старт ${dRu(o.start_date)} · готовность ${dRu(o.ready_date)}` : null,
    o.assigned_name ? `🙋 Ведёт: ${esc(o.assigned_name)}` : null,
  ].filter(Boolean).join("\n");
}

function adminKb(o: any) {
  const k = new InlineKeyboard();
  const a = (act: string) => `a:${act}:${o.id}`;
  if (o.status === "await_receipt") k.text("✅ Оплата получена", a("ok")).text("❌ Чек не подходит", a("bad")).row();
  if (o.status === "paid") k.text("🛠 Взять в работу", a("take")).row();
  if (o.status === "in_work") k.text("📦 Готово", a("ready")).row();
  if (o.status === "ready") k.text("🚚 Отправлено", a("ship")).row();
  if (["ready", "shipped"].includes(o.status)) k.text("🏁 Завершить в архив", a("done")).row();
  if (!["done", "cancelled", "expired"].includes(o.status)) k.text("🚫 Отменить заказ", a("cancel"));
  return k;
}

async function ensureTopic(o: any) {
  if (o.topic_id) return o;
  const t = await bot.api.createForumTopic(ADMIN_GROUP, topicName(o));
  const tid = t.message_thread_id;
  if (o.custom && o.custom_photo) {
    await bot.api.sendPhoto(ADMIN_GROUP, o.custom_photo, { message_thread_id: tid, caption: "Фото от клиента" });
  }
  const m = await bot.api.sendMessage(ADMIN_GROUP, card(o), {
    parse_mode: "HTML", message_thread_id: tid, reply_markup: adminKb(o),
  });
  const hint = o.status === "await_price"
    ? "Назначьте цену командой: <code>/price 450000 5</code> (сумма, срок в днях).\n"
    : "";
  await bot.api.sendMessage(ADMIN_GROUP,
    `${hint}Сообщения в этой теме уходят клиенту. Начните сообщение с точки, чтобы оставить заметку только для своих.`,
    { parse_mode: "HTML", message_thread_id: tid });
  await db.from("orders").update({ topic_id: tid, card_msg_id: m.message_id }).eq("id", o.id);
  return { ...o, topic_id: tid, card_msg_id: m.message_id };
}

async function refreshOrder(id: number) {
  const { data: o } = await db.from("orders").select("*").eq("id", id).single();
  if (!o || !o.topic_id) return o;
  try { await bot.api.editForumTopic(ADMIN_GROUP, o.topic_id, { name: topicName(o) }); } catch (_) { /* не изменилось */ }
  try {
    await bot.api.editMessageText(ADMIN_GROUP, o.card_msg_id, card(o), { parse_mode: "HTML", reply_markup: adminKb(o) });
  } catch (_) { /* не изменилось */ }
  return o;
}

async function nextStart(): Promise<string> {
  const from = addDays(todayStr(), 1);
  const { data } = await db.from("orders").select("start_date")
    .gte("start_date", from).not("status", "in", "(cancelled,expired)");
  const cnt: Record<string, number> = {};
  for (const r of data ?? []) cnt[r.start_date] = (cnt[r.start_date] ?? 0) + 1;
  let d = from;
  while ((cnt[d] ?? 0) >= CAPACITY) d = addDays(d, 1);
  return d;
}

async function sendPaymentOffer(o: any) {
  const start = await nextStart();
  const kb = new InlineKeyboard();
  if (CLICK_TOKEN) kb.text("💳 Click", `pay:click:${o.id}`);
  kb.text("🏦 Перевод на карту", `pay:card:${o.id}`);
  await bot.api.sendMessage(o.user_id, [
    `<b>Заказ #${o.id}</b> · ${esc(o.model_title ?? "Свой вариант")}`,
    `💰 Цена: ${money(o.price)} сум`,
    `⏱ Срок работы: ${o.term_days} дн.`,
    `📅 Ближайший старт: ${dRu(start)} <i>(фиксируется после предоплаты)</i>`,
    `💳 Предоплата ${PREPAY}%: <b>${money(o.prepay)} сум</b>`,
    `🚚 Доставка оплачивается отдельно`,
    `⏳ Бронь держится 24 часа`,
  ].join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

async function markPaid(id: number, how: string, who?: string) {
  const { data: o } = await db.from("orders").select("*").eq("id", id).single();
  if (!o || ["paid", "in_work", "ready", "shipped", "done", "cancelled", "expired"].includes(o.status)) return o;
  const start = await nextStart();
  const ready = addDays(start, o.term_days ?? 0);
  await db.from("orders").update({
    status: "paid", start_date: start, ready_date: ready, paid_at: new Date().toISOString(),
  }).eq("id", id);
  await logMsg(id, "system", who ?? null, `Оплата получена (${how})`);
  await bot.api.sendMessage(o.user_id,
    `✅ <b>Оплата получена!</b>\n📅 Начало работы: ${dRu(start)}\n⏱ Готовность: около ${dRu(ready)}\nСообщим, когда заказ будет готов.`,
    { parse_mode: "HTML", reply_markup: mainKb });
  const r = await refreshOrder(id);
  if (r?.topic_id) {
    await bot.api.sendMessage(ADMIN_GROUP, `✅ Оплата получена (${how}${who ? `, подтвердил ${esc(who)}` : ""}).`,
      { parse_mode: "HTML", message_thread_id: r.topic_id });
  }
  return r;
}

/* ============================ архив ============================ */
function archiveHtml(o: any, msgs: any[]) {
  const rows = msgs.map((m) =>
    `<div class="m ${m.direction}"><small>${esc(dtRu(m.created_at))} · ${esc(m.author ?? m.direction)}</small><br>${esc(m.text ?? "")}${m.file_kind ? ` <i>[${esc(m.file_kind)}]</i>` : ""}</div>`
  ).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Заказ #${o.id}</title>
<style>body{font:15px system-ui;max-width:640px;margin:20px auto;padding:0 12px}.m{margin:8px 0;padding:8px 10px;border-radius:10px;background:#eee}.in{background:#e6f1fb}.note{background:#faeeda}.system{background:#eaf3de}</style>
<h2>Заказ #${o.id}</h2><div style="white-space:pre-wrap">${card(o)}</div><h3>Переписка</h3>${rows}`;
}

async function archiveOrder(o: any) {
  const { data: msgs } = await db.from("messages").select("*").eq("order_id", o.id).order("id");
  const t = Number(await getSet("archive"));
  const extra: any = t ? { message_thread_id: t } : {};
  await bot.api.sendDocument(ADMIN_GROUP,
    new InputFile(new TextEncoder().encode(archiveHtml(o, msgs ?? [])), `order-${o.id}.html`),
    { caption: `🏁 Заказ #${o.id} · ${o.client_name} · ${o.model_title ?? "свой вариант"}`, ...extra });
  const photos = [o.custom_photo, ...(msgs ?? []).filter((m: any) => m.file_kind === "photo").map((m: any) => m.file_id)]
    .filter(Boolean).slice(0, 10);
  try {
    if (photos.length === 1) await bot.api.sendPhoto(ADMIN_GROUP, photos[0], extra);
    if (photos.length > 1) {
      await bot.api.sendMediaGroup(ADMIN_GROUP, photos.map((p: string) => ({ type: "photo" as const, media: p })), extra);
    }
  } catch (e) { console.error("archive photos", e); }
  await db.from("orders").update({ status: "done", done_at: new Date().toISOString() }).eq("id", o.id);
  if (o.topic_id) {
    await refreshOrder(o.id);
    try {
      if (DELETE_AFTER_ARCHIVE) await bot.api.deleteForumTopic(ADMIN_GROUP, o.topic_id);
      else await bot.api.closeForumTopic(ADMIN_GROUP, o.topic_id);
    } catch (e) { console.error("close topic", e); }
  }
}

/* ============================ КЛИЕНТ ============================ */
const menu = (ctx: Context) =>
  ctx.reply("Что хотите заказать?", {
    reply_markup: new InlineKeyboard().text("📸 Из каталога", "catalog").text("🎨 Свой вариант", "custom"),
  });

bot.command("id", (ctx) => ctx.reply(`chat_id: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" }));

bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await clearS(ctx);
  await ctx.reply("Здравствуйте! Нажмите «🛒 Заказать» внизу, чтобы выбрать работу.", { reply_markup: mainKb });
  const payload = String(ctx.match ?? "");
  if (payload.startsWith("m_")) return showCatalog(ctx, Number(payload.slice(2)));
  return menu(ctx);
});

bot.hears("🛒 Заказать", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await clearS(ctx);
  return menu(ctx);
});

async function slides() {
  const { data } = await db.from("products").select("id,title,price,term_days,photos")
    .eq("status", "published").order("id", { ascending: false }).limit(60);
  return (data ?? []).flatMap((p: any) => p.photos.map((f: string, i: number) => ({ p, f, i, n: p.photos.length })));
}
const slideCap = (s: any) =>
  `<b>${esc(titleOf(s.p))}</b>${s.n > 1 ? ` · фото ${s.i + 1}/${s.n}` : ""}\n\n💰 ${money(s.p.price)} сум\n⏱ Срок: ${s.p.term_days} дн.`;
const slideKb = (i: number, total: number, s: any) =>
  new InlineKeyboard()
    .text("◀", `cat:${(i - 1 + total) % total}`).text(`${i + 1} / ${total}`, "noop").text("▶", `cat:${(i + 1) % total}`)
    .row().text("✅ Выбрать эту модель", `pick:${s.p.id}`);

async function showCatalog(ctx: Context, productId?: number, edit = false, idx = 0) {
  const list = await slides();
  if (!list.length) return ctx.reply("Каталог пока пуст. Выберите «Свой вариант».");
  if (productId) {
    const k = list.findIndex((s: any) => s.p.id === productId);
    if (k >= 0) idx = k;
  }
  idx = Math.min(Math.max(idx, 0), list.length - 1);
  const s = list[idx];
  const markup = slideKb(idx, list.length, s);
  if (edit) {
    try {
      await ctx.editMessageMedia({ type: "photo", media: s.f, caption: slideCap(s), parse_mode: "HTML" }, { reply_markup: markup });
    } catch (e) { if (!String(e).includes("not modified")) throw e; }
  } else {
    await ctx.replyWithPhoto(s.f, { caption: slideCap(s), parse_mode: "HTML", reply_markup: markup });
  }
}

bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
bot.callbackQuery("catalog", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await showCatalog(ctx);
});
bot.callbackQuery(/^cat:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showCatalog(ctx, undefined, true, Number(ctx.match[1]));
});

bot.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const { data: p } = await db.from("products").select("*").eq("id", ctx.match[1]).single();
  if (!p || p.status !== "published") return ctx.reply("Эта модель уже недоступна.");
  const start = await nextStart();
  await setS(ctx, { step: "choose_region", data: { productId: p.id } });
  await ctx.reply(
    `<b>${esc(titleOf(p))}</b>\n💰 Цена: ${money(p.price)} сум\n⏱ Срок работы: ${p.term_days} дн.\n📅 Ближайшая дата начала: ${dRu(start)}\n<i>Дата закрепляется после предоплаты.</i>`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Продолжить", "region").text("Назад", "catalog") });
});

bot.callbackQuery("custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setS(ctx, { step: "custom_photo", data: { custom: true } });
  await ctx.reply("Пришлите фото того, что хотите заказать.");
});

const askRegion = (ctx: Context) =>
  ctx.reply("Куда доставить?", {
    reply_markup: new InlineKeyboard().text("Ташкент и область", "reg:t").text("Другой регион", "reg:o"),
  });

bot.callbackQuery("region", async (ctx) => { await ctx.answerCallbackQuery(); await askRegion(ctx); });
bot.callbackQuery("skipnote", async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = await getS(ctx);
  s.step = "choose_region";
  await setS(ctx, s);
  await askRegion(ctx);
});
bot.callbackQuery(/^reg:(t|o)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = await getS(ctx);
  s.data = { ...(s.data ?? {}), region: ctx.match[1] };
  s.step = "address";
  await setS(ctx, s);
  await ctx.reply(
    ctx.match[1] === "t"
      ? "Доставка Яндекс.\nНапишите адрес: район, улица, дом, ориентир."
      : "Доставка СДЭК или местной службой.\nНапишите область, город и адрес (или пункт выдачи).");
  await ctx.reply("🚚 Доставку оплачивает покупатель. Стоимость назовёт менеджер, когда работа будет готова.");
});

async function handlePrivate(ctx: Context) {
  const m: any = ctx.message;
  const s = await getS(ctx);
  switch (s.step) {
    case "custom_photo":
      if (!m.photo) return ctx.reply("Пришлите, пожалуйста, фото.");
      s.data!.photo = m.photo.at(-1).file_id;
      s.step = "custom_note";
      await setS(ctx, s);
      return ctx.reply("Добавьте комментарий: размер, цвет, пожелания.", {
        reply_markup: new InlineKeyboard().text("Пропустить", "skipnote"),
      });
    case "custom_note":
      if (!m.text) return ctx.reply("Напишите комментарий текстом или нажмите «Пропустить».");
      s.data!.note = m.text;
      s.step = "choose_region";
      await setS(ctx, s);
      return askRegion(ctx);
    case "address":
      if (!m.text) return ctx.reply("Напишите адрес текстом.");
      s.data!.address = m.text;
      s.step = "phone";
      await setS(ctx, s);
      return ctx.reply("Номер телефона для связи и доставки:", {
        reply_markup: new Keyboard().requestContact("📱 Отправить мой номер").resized().oneTime(),
      });
    case "phone": {
      const phone = m.contact?.phone_number ?? m.text;
      if (!phone) return ctx.reply("Отправьте номер кнопкой или напишите текстом.");
      s.data!.phone = phone;
      await setS(ctx, s);
      return finalize(ctx, s);
    }
    case "choose_region":
      return ctx.reply("Выберите вариант кнопкой выше или нажмите «🛒 Заказать», чтобы начать заново.");
  }
  return relayFromClient(ctx);
}

async function finalize(ctx: Context, s: S) {
  const d = s.data!;
  const u = ctx.from!;
  const base = {
    user_id: u.id, username: u.username ?? null,
    client_name: [u.first_name, u.last_name].filter(Boolean).join(" "),
    phone: d.phone, region: d.region, address: d.address,
  };
  await clearS(ctx);
  if (d.custom) {
    const { data: o } = await db.from("orders").insert({
      ...base, custom: true, custom_photo: d.photo, custom_note: d.note ?? null, status: "await_price",
    }).select().single();
    await ctx.reply(`Заявка #${o.id} принята. Менеджер оценит работу и напишет цену и срок прямо здесь.`, { reply_markup: mainKb });
    await ensureTopic(o);
    return;
  }
  const { data: p } = await db.from("products").select("*").eq("id", d.productId).single();
  const prepay = Math.round((p.price * PREPAY) / 100);
  const { data: o } = await db.from("orders").insert({
    ...base, product_id: p.id, model_title: titleOf(p), price: p.price, prepay, term_days: p.term_days,
    status: "await_payment", expires_at: new Date(Date.now() + 24 * 3600e3).toISOString(),
  }).select().single();
  await ctx.reply("Спасибо! Осталось внести предоплату.", { reply_markup: mainKb });
  await sendPaymentOffer(o);
}

bot.callbackQuery(/^pay:(click|card):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const { data: o } = await db.from("orders").select("*").eq("id", ctx.match[2]).single();
  if (!o || o.user_id !== ctx.from.id) return;
  if (o.status !== "await_payment" || o.pay_method) {
    return ctx.reply(o.pay_method ? "Способ оплаты уже выбран. Если нужно сменить, напишите в этот чат." : "Этот заказ уже недоступен.");
  }
  const method = ctx.match[1];
  if (method === "click" && !CLICK_TOKEN) return ctx.reply("Оплата через Click пока недоступна.");
  const { data: o2 } = await db.from("orders")
    .update({ pay_method: method, status: method === "card" ? "await_receipt" : "await_payment" })
    .eq("id", o.id).select().single();
  await ensureTopic(o2);
  if (method === "click") {
    await ctx.api.raw.sendInvoice({
      chat_id: o.user_id, title: `Заказ #${o.id}`,
      description: `Предоплата ${PREPAY}%: ${o.model_title ?? "свой вариант"}`,
      payload: `order:${o.id}`, provider_token: CLICK_TOKEN, currency: "UZS",
      prices: [{ label: "Предоплата", amount: Math.round(o.prepay * 100) }],
    });
  } else {
    await ctx.reply(
      `<b>Перевод на карту</b>\n💳 ${esc(CARD_NUMBER)}\n👤 ${esc(CARD_HOLDER)}\n💰 Сумма: <b>${money(o.prepay)} сум</b>\n📝 Комментарий: заказ #${o.id}\n\nПосле перевода пришлите сюда скриншот чека.`,
      { parse_mode: "HTML" });
    if (QR_URL) await ctx.replyWithPhoto(QR_URL, { caption: "QR для оплаты" }).catch(() => {});
  }
});

bot.on("pre_checkout_query", async (ctx) => {
  const id = Number(ctx.preCheckoutQuery.invoice_payload.replace("order:", ""));
  const { data: o } = await db.from("orders").select("status,pay_method").eq("id", id).maybeSingle();
  const ok = !!o && o.status === "await_payment" && o.pay_method === "click";
  await ctx.api.raw.answerPreCheckoutQuery({
    pre_checkout_query_id: ctx.preCheckoutQuery.id, ok,
    ...(ok ? {} : { error_message: "Заказ недоступен. Оформите его заново." }),
  });
});
bot.on("message:successful_payment", async (ctx) => {
  const id = Number(ctx.message.successful_payment.invoice_payload.replace("order:", ""));
  await markPaid(id, "Click");
});

async function relayFromClient(ctx: Context) {
  const m: any = ctx.message;
  const { data: o } = await db.from("orders").select("*").eq("user_id", ctx.from!.id)
    .not("status", "in", "(done,cancelled,expired)").not("topic_id", "is", null)
    .order("id", { ascending: false }).limit(1).maybeSingle();
  if (!o) return ctx.reply("Нажмите «🛒 Заказать», чтобы оформить заказ.", { reply_markup: mainKb });
  await bot.api.copyMessage(ADMIN_GROUP, ctx.chat!.id, m.message_id, { message_thread_id: o.topic_id });
  const kind = m.photo ? "photo" : m.document ? "document" : m.voice ? "voice" : m.video ? "video" : null;
  const fid = m.photo ? m.photo.at(-1).file_id : m.document?.file_id ?? null;
  await logMsg(o.id, "in", o.client_name, m.text ?? m.caption, fid, kind);
  if (o.status === "await_receipt" && !o.receipt_sent && (m.photo || m.document)) {
    await db.from("orders").update({ receipt_sent: true }).eq("id", o.id);
    await refreshOrder(o.id);
    await bot.api.sendMessage(ADMIN_GROUP, "🧾 Клиент прислал чек. Проверьте поступление и подтвердите оплату кнопкой в карточке заказа.",
      { message_thread_id: o.topic_id });
    await ctx.reply("Чек получен, проверяем. Обычно до 30 минут.");
  }
}

/* ============================ АДМИНЫ: общее ============================ */
const inAdmin = (ctx: Context) => ctx.chat?.id === ADMIN_GROUP;
const tidOf = (ctx: Context) => (ctx.msg as any)?.message_thread_id as number | undefined;
const orderByTopic = async (tid?: number) =>
  tid ? (await db.from("orders").select("*").eq("topic_id", tid).maybeSingle()).data : null;

bot.command("bind", async (ctx) => {
  if (!inAdmin(ctx)) return;
  const key = String(ctx.match).trim();
  const tid = tidOf(ctx);
  if (!["products", "ideas", "archive"].includes(key) || !tid) {
    return ctx.reply("Напишите команду внутри нужной темы: /bind products, /bind ideas или /bind archive.");
  }
  await setSet(key, String(tid));
  await ctx.reply(`✅ Тема привязана: ${key}`);
});

bot.command("price", async (ctx) => {
  if (!inAdmin(ctx)) return;
  const o = await orderByTopic(tidOf(ctx));
  if (!o) return ctx.reply("Эту команду нужно писать в теме заказа.");
  if (!["await_price", "await_payment"].includes(o.status) || o.pay_method) {
    return ctx.reply("Цену можно менять, пока клиент не выбрал способ оплаты.");
  }
  const [pr, days] = String(ctx.match).trim().split(/\s+/);
  const price = num(pr ?? "");
  const term = days ? num(days) : o.term_days;
  if (!price || !term) return ctx.reply("Формат: /price 450000 5 (сумма и срок в днях)");
  const { data: o2 } = await db.from("orders").update({
    price, prepay: Math.round((price * PREPAY) / 100), term_days: term, status: "await_payment",
    expires_at: new Date(Date.now() + 24 * 3600e3).toISOString(), reminders: 0,
  }).eq("id", o.id).select().single();
  await refreshOrder(o.id);
  await sendPaymentOffer(o2);
  await ctx.reply("Клиенту отправлен счёт на предоплату.");
});

/* ============================ АДМИНЫ: товары ============================ */
bot.command("list", async (ctx) => {
  if (!inAdmin(ctx)) return;
  const { data } = await db.from("products").select("id,title,price,status").neq("status", "draft")
    .order("id", { ascending: false }).limit(15);
  await ctx.reply((data ?? []).map((p: any) => `#${p.id} ${titleOf(p)} · ${money(p.price)} · ${p.status}`).join("\n") || "Пока пусто.");
});
bot.command("queue", async (ctx) => {
  if (!inAdmin(ctx)) return;
  const { data } = await db.from("products").select("id,title,publish_at").eq("status", "scheduled").order("publish_at");
  await ctx.reply((data ?? []).map((p: any) => `#${p.id} ${titleOf(p)} · ${dtRu(p.publish_at)}`).join("\n") || "Очередь пуста.");
});
bot.command("setprice", async (ctx) => {
  if (!inAdmin(ctx)) return;
  const [id, pr] = String(ctx.match).trim().split(/\s+/);
  const price = num(pr ?? "");
  if (!Number(id) || !price) return ctx.reply("Формат: /setprice 15 450000");
  const { data: p } = await db.from("products").update({ price }).eq("id", Number(id)).select().single();
  if (p?.channel_msg_id && p.status === "published") {
    await bot.api.editMessageCaption(CHANNEL, p.channel_msg_id, {
      caption: postCaption(p), parse_mode: "HTML", reply_markup: postKb(p.id),
    }).catch(() => {});
  }
  await ctx.reply("Цена обновлена.");
});
bot.command(["hide", "show"], async (ctx) => {
  if (!inAdmin(ctx)) return;
  const id = Number(String(ctx.match).trim());
  const { data: p } = await db.from("products").select("*").eq("id", id).single();
  if (!p) return ctx.reply("Модель не найдена. Формат: /hide 15");
  const hide = ctx.msg!.text!.startsWith("/hide");
  await db.from("products").update({ status: hide ? "hidden" : "published" }).eq("id", id);
  if (p.channel_msg_id) {
    await bot.api.editMessageCaption(CHANNEL, p.channel_msg_id, {
      caption: postCaption(p) + (hide ? "\n\n⛔ Нет в наличии" : ""), parse_mode: "HTML",
      reply_markup: hide ? new InlineKeyboard() : postKb(p.id),
    }).catch(() => {});
  }
  await ctx.reply(hide ? "Модель скрыта из каталога." : "Модель снова доступна.");
});

async function startDraft(ctx: Context, productId: number) {
  await setS(ctx, { step: "p_price", data: { productId } });
}

async function productsTopic(ctx: Context) {
  const m: any = ctx.message;
  if (m.photo) {
    const { data } = await db.rpc("add_draft_photo", {
      p_group: m.media_group_id ?? null, p_file: m.photo.at(-1).file_id, p_admin: ctx.from!.id,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.created) {
      await startDraft(ctx, row.id);
      await ctx.reply("📸 Фото получено (если это альбом, остальные добавятся сами).\nЦена в сумах? Напишите число.");
    }
    return;
  }
  const s = await getS(ctx);
  const t = m.text?.trim();
  if (!t || !s.step?.startsWith("p_")) return;
  const id = s.data!.productId;
  if (s.step === "p_price") {
    const n = num(t);
    if (!n) return ctx.reply("Введите цену числом, например 450000");
    await db.from("products").update({ price: n }).eq("id", id);
    s.step = "p_term"; await setS(ctx, s);
    return askTerm(ctx);
  }
  if (s.step === "p_term") {
    const n = num(t);
    if (!n) return ctx.reply("Введите срок числом, например 5");
    return setTerm(ctx, s, n);
  }
  if (s.step === "p_title") {
    await db.from("products").update({ title: t }).eq("id", id);
    s.step = "p_when"; await setS(ctx, s);
    return askWhen(ctx);
  }
  if (s.step === "p_when_text") {
    const dt = parseWhen(t);
    if (!dt) return ctx.reply("Не понял дату. Формат: 05.11 12:30");
    await db.from("products").update({ publish_at: dt.toISOString() }).eq("id", id);
    s.step = "p_confirm"; await setS(ctx, s);
    return preview(ctx, id);
  }
}

const askTerm = (ctx: Context) =>
  ctx.reply("Срок работы, дней? Выберите или напишите число.", {
    reply_markup: new InlineKeyboard().text("3", "pt:3").text("5", "pt:5").text("7", "pt:7").text("10", "pt:10"),
  });
async function setTerm(ctx: Context, s: S, n: number) {
  await db.from("products").update({ term_days: n }).eq("id", s.data!.productId);
  s.step = "p_title"; await setS(ctx, s);
  await ctx.reply("Название? Напишите текстом или пропустите.", {
    reply_markup: new InlineKeyboard().text("Пропустить", "ptitle:skip"),
  });
}
const askWhen = (ctx: Context) =>
  ctx.reply("Когда опубликовать в канале?", {
    reply_markup: new InlineKeyboard()
      .text("Сейчас", "pw:now").text("Сегодня 18:00", "pw:t18").row()
      .text("Завтра 10:00", "pw:tom10").text("Другая дата", "pw:custom"),
  });

async function preview(ctx: Context, id: number) {
  const { data: p } = await db.from("products").select("*").eq("id", id).single();
  const soon = !p.publish_at || new Date(p.publish_at).getTime() <= Date.now() + 60e3;
  const extra = p.photos.length > 1 ? `\n📚 Ещё ${p.photos.length - 1} фото будут в карусели бота` : "";
  await ctx.replyWithPhoto(p.photos[0], {
    caption: `${postCaption(p)}${extra}\n\n📅 Публикация: ${soon ? "сразу" : dtRu(p.publish_at)}`,
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().url("🛒 Заказать", deepLink(p.id)).row()
      .text(soon ? "✅ Опубликовать" : "🗓 Запланировать", `pc:ok:${id}`).text("❌ Отмена", `pc:cancel:${id}`),
  });
}

bot.callbackQuery(/^pt:(\d+)$/, async (ctx) => {
  if (!inAdmin(ctx)) return;
  await ctx.answerCallbackQuery();
  const s = await getS(ctx);
  if (s.step !== "p_term") return;
  await setTerm(ctx, s, Number(ctx.match[1]));
});
bot.callbackQuery("ptitle:skip", async (ctx) => {
  if (!inAdmin(ctx)) return;
  await ctx.answerCallbackQuery();
  const s = await getS(ctx);
  if (s.step !== "p_title") return;
  s.step = "p_when"; await setS(ctx, s);
  await askWhen(ctx);
});
bot.callbackQuery(/^pw:(now|t18|tom10|custom)$/, async (ctx) => {
  if (!inAdmin(ctx)) return;
  await ctx.answerCallbackQuery();
  const s = await getS(ctx);
  if (s.step !== "p_when") return;
  const k = ctx.match[1];
  if (k === "custom") {
    s.step = "p_when_text"; await setS(ctx, s);
    return ctx.reply("Напишите дату и время в формате 05.11 12:30");
  }
  let dt = new Date();
  if (k === "t18") {
    dt = atTz(todayStr(), 18);
    if (dt.getTime() < Date.now()) dt = atTz(addDays(todayStr(), 1), 18);
  }
  if (k === "tom10") dt = atTz(addDays(todayStr(), 1), 10);
  await db.from("products").update({ publish_at: dt.toISOString() }).eq("id", s.data!.productId);
  s.step = "p_confirm"; await setS(ctx, s);
  await preview(ctx, s.data!.productId);
});
bot.callbackQuery(/^pc:(ok|cancel):(\d+)$/, async (ctx) => {
  if (!inAdmin(ctx)) return;
  await ctx.answerCallbackQuery();
  const id = Number(ctx.match[2]);
  const { data: p } = await db.from("products").select("*").eq("id", id).single();
  if (!p || p.status !== "draft") return ctx.reply("Эта публикация уже обработана.");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  await clearS(ctx);
  if (ctx.match[1] === "cancel") {
    await db.from("products").delete().eq("id", id);
    return ctx.reply("Черновик удалён.");
  }
  if (!p.publish_at || new Date(p.publish_at).getTime() <= Date.now() + 60e3) {
    await publishProduct(id);
    return ctx.reply(`✅ Опубликовано в канале. Ссылка: ${deepLink(id)}`);
  }
  await db.from("products").update({ status: "scheduled" }).eq("id", id);
  return ctx.reply(`🗓 Запланировано на ${dtRu(p.publish_at)}. Очередь: /queue`);
});

/* ============================ АДМИНЫ: идеи ============================ */
async function ideasTopic(ctx: Context) {
  const m: any = ctx.message;
  const fid = m.photo?.at(-1).file_id ?? null;
  const note = m.text ?? m.caption ?? null;
  if (!fid && !note) return;
  const { data: idea } = await db.from("ideas").insert({ file_id: fid, note, created_by: ctx.from!.id }).select().single();
  await ctx.reply(`💡 Идея #${idea.id} сохранена.`, {
    reply_markup: fid ? new InlineKeyboard().text("➡️ В товары", `i2p:${idea.id}`) : undefined,
  });
}
bot.callbackQuery(/^i2p:(\d+)$/, async (ctx) => {
  if (!inAdmin(ctx)) return;
  const { data: idea } = await db.from("ideas").select("*").eq("id", ctx.match[1]).single();
  if (!idea || idea.status !== "new" || !idea.file_id) return ctx.answerCallbackQuery({ text: "Уже перенесено" });
  const { data } = await db.rpc("add_draft_photo", { p_group: null, p_file: idea.file_id, p_admin: ctx.from.id });
  const row = Array.isArray(data) ? data[0] : data;
  await db.from("ideas").update({ status: "moved" }).eq("id", idea.id);
  await startDraft(ctx, row.id);
  await send("products", `📸 Идея #${idea.id} перенесена. Цена в сумах? Напишите число.`);
  await ctx.answerCallbackQuery({ text: "Перенесено в «Товары»" });
});

/* ============================ АДМИНЫ: заказы ============================ */
async function orderTopic(ctx: Context, o: any) {
  const m: any = ctx.message;
  const txt: string = m.text ?? m.caption ?? "";
  if (txt.startsWith("/")) return;
  const who = ctx.from!.first_name;
  if (txt.startsWith(".")) { await logMsg(o.id, "note", who, txt.slice(1).trim()); return; }
  if (["done", "cancelled", "expired"].includes(o.status)) return;
  try {
    await bot.api.copyMessage(o.user_id, ADMIN_GROUP, m.message_id);
    await logMsg(o.id, "out", who, txt, m.photo ? m.photo.at(-1).file_id : null, m.photo ? "photo" : null);
  } catch (_) {
    await ctx.reply("⚠️ Не удалось доставить сообщение клиенту (возможно, он остановил бота).");
  }
}

bot.callbackQuery(/^a:(\w+):(\d+)$/, async (ctx) => {
  if (!inAdmin(ctx)) return ctx.answerCallbackQuery();
  const act = ctx.match[1];
  const id = Number(ctx.match[2]);
  const { data: o } = await db.from("orders").select("*").eq("id", id).single();
  if (!o) return ctx.answerCallbackQuery({ text: "Заказ не найден" });
  const who = ctx.from.first_name;
  const tell = (t: string) => bot.api.sendMessage(o.user_id, t, { parse_mode: "HTML" }).catch(() => {});
  const setStatus = async (status: string, extra: any = {}) => {
    await db.from("orders").update({ status, ...extra }).eq("id", id);
    await refreshOrder(id);
  };
  switch (act) {
    case "ok":
      if (o.status !== "await_receipt") return ctx.answerCallbackQuery({ text: "Уже обработано" });
      await markPaid(id, "карта", who);
      break;
    case "bad":
      if (o.status !== "await_receipt") return ctx.answerCallbackQuery({ text: "Уже обработано" });
      await db.from("orders").update({ receipt_sent: false }).eq("id", id);
      await refreshOrder(id);
      await tell("❗️ Чек не подошёл: платёж не найден или сумма не совпала. Проверьте и отправьте чек ещё раз.");
      break;
    case "take":
      if (o.status !== "paid") return ctx.answerCallbackQuery({ text: "Сейчас это действие недоступно" });
      await setStatus("in_work", { assigned_to: ctx.from.id, assigned_name: who });
      await tell("🛠 Мастер приступил к работе над вашим заказом.");
      break;
    case "ready": {
      if (o.status !== "in_work") return ctx.answerCallbackQuery({ text: "Сейчас это действие недоступно" });
      await setStatus("ready");
      const rest = (o.price ?? 0) - (o.prepay ?? 0);
      await tell(`📦 <b>Заказ #${id} готов!</b>\nОстаток к оплате: <b>${money(rest)} сум</b>.\nСтоимость доставки (${o.region === "t" ? "Яндекс" : "СДЭК/местная служба"}) подтвердит менеджер.\n\n💳 ${esc(CARD_NUMBER)}\n👤 ${esc(CARD_HOLDER)}\nПосле перевода пришлите чек сюда.`);
      break;
    }
    case "ship":
      if (o.status !== "ready") return ctx.answerCallbackQuery({ text: "Сейчас это действие недоступно" });
      await setStatus("shipped");
      await tell("🚚 Ваш заказ отправлен. Менеджер пришлёт данные для отслеживания.");
      break;
    case "done":
      if (!["ready", "shipped"].includes(o.status)) return ctx.answerCallbackQuery({ text: "Сейчас это действие недоступно" });
      await tell("🏁 Заказ завершён. Спасибо, что выбрали нас!");
      await archiveOrder(o);
      break;
    case "cancel":
      await setStatus("cancelled");
      await tell(`Заказ #${id} отменён. Если это ошибка, напишите нам.`);
      if (o.topic_id) await bot.api.closeForumTopic(ADMIN_GROUP, o.topic_id).catch(() => {});
      break;
  }
  await ctx.answerCallbackQuery({ text: "Готово" });
});

/* ============================ маршрутизация сообщений ============================ */
bot.on("message", async (ctx) => {
  if (ctx.chat.type === "private") return handlePrivate(ctx);
  if (!inAdmin(ctx) || ctx.from?.is_bot) return;
  const tid = tidOf(ctx);
  if (tid && tid === Number(await getSet("products"))) return productsTopic(ctx);
  if (tid && tid === Number(await getSet("ideas"))) return ideasTopic(ctx);
  const o = await orderByTopic(tid);
  if (o) return orderTopic(ctx, o);
});

/* ============================ планировщик (раз в минуту) ============================ */
async function tick() {
  const now = new Date();
  // 1. отложенные публикации
  const { data: due } = await db.from("products").select("*").eq("status", "scheduled").lte("publish_at", now.toISOString());
  for (const p of due ?? []) {
    try {
      await publishProduct(p.id);
      await send("products", `✅ Опубликовано по расписанию: <b>${esc(titleOf(p))}</b>`);
    } catch (e) { await send("products", `⚠️ Не удалось опубликовать #${p.id}: ${esc(String(e))}`); }
  }
  // 2. напоминание за 15 минут
  const soon = new Date(now.getTime() + 15 * 60e3).toISOString();
  const { data: near } = await db.from("products").select("*").eq("status", "scheduled")
    .eq("reminded", false).lte("publish_at", soon);
  for (const p of near ?? []) {
    await db.from("products").update({ reminded: true }).eq("id", p.id);
    await send("products", `⏰ Через 15 минут выйдет пост: <b>${esc(titleOf(p))}</b>. Отменить: /hide ${p.id}`);
  }
  // 3. напоминания и истечение брони
  const { data: pend } = await db.from("orders").select("*")
    .in("status", ["await_payment", "await_receipt"]).not("expires_at", "is", null);
  for (const o of pend ?? []) {
    if (o.receipt_sent) continue;
    const ageH = (now.getTime() - (new Date(o.expires_at).getTime() - 24 * 3600e3)) / 3600e3;
    if (ageH >= 24) {
      await db.from("orders").update({ status: "expired" }).eq("id", o.id);
      await bot.api.sendMessage(o.user_id, `Бронь заказа #${o.id} истекла. Чтобы оформить заново, нажмите «🛒 Заказать».`).catch(() => {});
      if (o.topic_id) {
        await refreshOrder(o.id);
        await bot.api.closeForumTopic(ADMIN_GROUP, o.topic_id).catch(() => {});
      }
    } else if ((o.reminders === 0 && ageH >= 3) || (o.reminders === 1 && ageH >= 12)) {
      await db.from("orders").update({ reminders: o.reminders + 1 }).eq("id", o.id);
      await bot.api.sendMessage(o.user_id,
        `⏰ Заказ #${o.id} ждёт предоплаты ${money(o.prepay)} сум. Бронь действует до ${dtRu(o.expires_at)}.`).catch(() => {});
    }
  }
  // 4. утренняя сводка в тему «Всё»
  if (nowTz().getUTCHours() >= 9 && (await getSet("digest")) !== todayStr()) {
    await setSet("digest", todayStr());
    const { data: all } = await db.from("orders").select("status").not("status", "in", "(done,cancelled,expired)");
    const c = (s: string[]) => (all ?? []).filter((x: any) => s.includes(x.status)).length;
    const { count } = await db.from("products").select("id", { count: "exact", head: true }).eq("status", "scheduled");
    await send(null, `☀️ <b>Сводка на ${dRu(todayStr())}</b>\n⏳ Ждут оплаты: ${c(["await_payment", "await_receipt"])}\n💬 Ждут цену: ${c(["await_price"])}\n🛠 В работе: ${c(["paid", "in_work"])}\n📦 Готовы: ${c(["ready", "shipped"])}\n🗓 Постов в очереди: ${count ?? 0}`);
  }
}

/* ============================ вход ============================ */
const handle = webhookCallback(bot, "std/http", { secretToken: env("WEBHOOK_SECRET") });
Deno.serve(async (req) => {
  const task = new URL(req.url).searchParams.get("task");
  if (task === "ping") {
    await db.from("settings").select("key").limit(1);
    return new Response("ok");
  }
  if (task === "tick") {
    if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
      return new Response("forbidden", { status: 403 });
    }
    try { await tick(); } catch (e) { console.error("tick", e); }
    return new Response("ok");
  }
  try { return await handle(req); } catch (e) { console.error(e); return new Response("ok"); }
});
