import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import {useSettingStore} from "@/store/setting.js";
const settingStore = useSettingStore();
dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale(settingStore.lang === 'en' ? 'en' : 'zh-cn')
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function fromNow(date) {
    const d = dayjs.utc(date).tz(timeZone);
    const now = dayjs();
    const diffSeconds = now.diff(d, 'second');
    const diffMinutes = now.diff(d, 'minute');
    const diffHours = now.diff(d, 'hour');
    const isToday = now.isSame(d, 'day');
    if (settingStore.lang === 'en') {

        if (isToday) {
            if (diffSeconds < 60) return `Just now`;
            if (diffMinutes < 60) return `${diffMinutes} min ago`;
            if (diffHours < 2) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            return d.format('hh:mm A');
        }

        if (now.subtract(1, 'day').isSame(d, 'day')) {
            return d.format('MMM D');
        }

        return d.year() === now.year()
            ? d.format('MMM D')
            : d.format('YYYY/MM/DD');


    } else {

        if (isToday) {
            if (diffSeconds < 60) return `几秒前`;
            if (diffMinutes < 60) return `${diffMinutes}分钟前`;
            if (diffHours >= 1 && diffHours < 2) return '1小时前';
            return d.format('HH:mm');
        }
        else if (now.subtract(1, 'day').isSame(d, 'day')) {
            return `昨天 ${d.format('HH:mm')}`;
        }
        else if (now.subtract(2, 'day').isSame(d, 'day')) {
            return `前天 ${d.format('HH:mm')}`;
        }
        return d.year() === now.year()
            ? d.format('M月D日')
            : d.format('YYYY/M/D');

    }

}

export function updateNow(date) {
    if (isToday) {
        if (diffSeconds < 60) return `Just now`;
        if (diffMinutes < 60) return `${diffMinutes} min ago`;
        if (diffHours < 2) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        return d.format('hh:mm A');
    }
}

export function formatDetailDate(time) {
    const d = dayjs.utc(time).tz(timeZone);
    const now = dayjs();

    const isSameYear = now.year() === d.year();

    if (settingStore.lang === 'en') {
        return isSameYear
            ? d.format('ddd, MMM D, h:mm A')
            : d.format('ddd, MMM D, YYYY, h:mm A');
    } else {
        return d.format('YYYY年M月D日 ddd AH:mm');
    }
}

export function tzDayjs(time) {
    return dayjs.utc(time).tz(timeZone)
}

export function toUtc(time) {
    return dayjs(time).utc()
}

export function setExtend(lang) {
    dayjs.locale(lang)
}

function calendarLocalDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value || '')
    if (!match) return null
    return new Date(Date.UTC(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0),
    ))
}

/** Format a normalized calendar point without inventing timezone information. */
export function formatCalendarPoint(point, locale = 'en') {
    if (!point || typeof point !== 'object') return null
    const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    if ((point.kind === 'utc' || point.kind === 'zoned') && typeof point.instant === 'string') {
        const instant = new Date(point.instant)
        if (Number.isNaN(instant.getTime())) return null
        return {
            kind: point.kind,
            text: new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium', timeStyle: 'short', timeZone: viewerTimeZone,
            }).format(instant),
            viewerTimeZone,
            sourceTimeZone: typeof point.timezone === 'string' ? point.timezone : null,
        }
    }
    if (!['all-day', 'floating', 'unresolved'].includes(point.kind) || typeof point.value !== 'string') return null
    const local = calendarLocalDate(point.value)
    if (!local) return null
    return {
        kind: point.kind,
        text: new Intl.DateTimeFormat(locale, point.kind === 'all-day'
            ? {dateStyle: 'medium', timeZone: 'UTC'}
            : {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'}).format(local),
        viewerTimeZone: null,
        sourceTimeZone: typeof point.timezone === 'string' ? point.timezone : null,
    }
}
