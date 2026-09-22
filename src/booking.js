'use strict';

/**
 * booking.js — simple slot model for the MVP.
 *
 * Rules:
 *  - If the business is open now and at least 90 minutes remain before close,
 *    offer today in the next upcoming 2-hour window.
 *  - Otherwise offer the next open day, first 2-hour window after opening.
 *
 * TODO (post-MVP): replace nextAvailableSlot() with Google Calendar freebusy
 * lookup. Hooks are ready: set GOOGLE_CALENDAR_ID per business and implement
 * findFreeSlot() in this module; the conversation engine already calls only
 * nextAvailableSlot().
 */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayKey(date) {
  return DAY_KEYS[date.getDay()];
}

function parseHM(hm) {
  const [h, m] = hm.split(':').map(Number);
  return { h, m };
}

function atTime(date, hm) {
  const { h, m } = parseHM(hm);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

function minutesUntilClose(business, now) {
  const hours = business.hours[dayKey(now)];
  if (!hours || !hours.open) return 0;
  return Math.max(0, Math.round((atTime(now, hours.close) - now) / 60000));
}

function isOpenNow(business, now) {
  const hours = business.hours[dayKey(now)];
  if (!hours || !hours.open || !hours.close) return false;
  const open = atTime(now, hours.open);
  const close = atTime(now, hours.close);
  return now >= open && now < close;
}

function fmtTime(date) {
  let h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function dayLabel(slotDate, now) {
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(slotDate); b.setHours(0, 0, 0, 0);
  const diffDays = Math.round((b - a) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  return DAY_NAMES[slotDate.getDay()];
}

/**
 * Returns { date, windowStart: Date, windowEnd: Date, label } or null if no
 * open day is found within 14 days.
 */
function nextAvailableSlot(business, now) {
  // Today, if open with >= 90 minutes left.
  if (isOpenNow(business, now) && minutesUntilClose(business, now) >= 90) {
    const start = new Date(now.getTime() + 60 * 60000);
    start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0); // snap to :00/:30
    const end = new Date(start.getTime() + 2 * 3600000);
    const close = atTime(now, business.hours[dayKey(now)].close);
    if (end <= close) {
      return {
        date: new Date(now),
        windowStart: start,
        windowEnd: end,
        label: `today between ${fmtTime(start)} and ${fmtTime(end)}`,
      };
    }
  }

  // Otherwise: next open day, first 2-hour window after opening.
  for (let i = 0; i < 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const hours = business.hours[dayKey(d)];
    if (!hours || !hours.open || !hours.close) continue;
    const start = atTime(d, hours.open);
    const end = new Date(start.getTime() + 2 * 3600000);
    const close = atTime(d, hours.close);
    if (end > close) continue;
    if (i === 0 && start <= now) continue; // opening already passed today
    return {
      date: d,
      windowStart: start,
      windowEnd: end,
      label: `${dayLabel(d, now)} between ${fmtTime(start)} and ${fmtTime(end)}`,
    };
  }
  return null;
}

module.exports = { isOpenNow, minutesUntilClose, nextAvailableSlot, dayKey, DAY_NAMES };
