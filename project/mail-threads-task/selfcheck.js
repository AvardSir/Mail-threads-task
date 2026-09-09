#!/usr/bin/env node
"use strict";
/**
 * Самопроверка выгрузки кандидата.
 *
 *   node selfcheck.js out/result.jsonl
 *
 * Скрипт НЕ знает правильного ответа. Он считает статистику по самому файлу
 * и указывает на признаки, которые почти всегда означают ошибку в решении.
 *
 * Собирается в один файл без зависимостей:
 *   npx tsc selfcheck.ts --target es2022 --module commonjs --outDir dist
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_readline_1 = require("node:readline");
// ---------------------------------------------------------------- пороги
const T = {
    /** доля писем в одном разговоре, выше которой это похоже на склейку */
    giantThreadShare: 0.25,
    /** доля разговоров из одного письма, выше которой связи явно не восстановлены */
    singletonShare: 0.7,
    /** ниже этого числа писем обход, скорее всего, не дошёл до конца */
    suspiciouslyFewMessages: 20_000,
    /** сколько примеров показывать в тексте замечания */
    examples: 3,
};
// ---------------------------------------------------------------- вывод
const num = (n) => n.toLocaleString('ru-RU');
const pct = (part, total) => total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`;
function row(label, value, extra = '') {
    const pad = label.padEnd(34, ' ');
    const val = value.padStart(11, ' ');
    console.log(`  ${pad}${val}${extra ? '  ' + extra : ''}`);
}
function section(title) {
    console.log('');
    console.log(title);
}
function wrap(text, width = 68) {
    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
        if ((cur + ' ' + w).trim().length > width) {
            lines.push(cur.trim());
            cur = w;
        }
        else {
            cur += ' ' + w;
        }
    }
    if (cur.trim())
        lines.push(cur.trim());
    return lines;
}
// ---------------------------------------------------------------- чтение
async function readRows(path) {
    const rows = [];
    const badLines = [];
    let lineNo = 0;
    const rl = (0, node_readline_1.createInterface)({
        input: (0, node_fs_1.createReadStream)(path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    for await (const raw of rl) {
        lineNo++;
        const line = raw.trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            if (badLines.length < 20)
                badLines.push({ line: lineNo, reason: 'строка не является корректным JSON' });
            continue;
        }
        const o = parsed;
        const missing = ['external_id', 'thread_key', 'sent_at', 'subject'].filter((f) => typeof o[f] !== 'string' || o[f].length === 0);
        if (missing.length) {
            if (badLines.length < 20)
                badLines.push({ line: lineNo, reason: `не заполнены поля: ${missing.join(', ')}` });
            continue;
        }
        if (o.parent_id !== undefined && typeof o.parent_id !== 'string') {
            if (badLines.length < 20)
                badLines.push({ line: lineNo, reason: 'поле parent_id должно быть строкой' });
            continue;
        }
        if (Number.isNaN(Date.parse(o.sent_at))) {
            if (badLines.length < 20)
                badLines.push({ line: lineNo, reason: 'поле sent_at не разбирается как дата' });
            continue;
        }
        rows.push({
            external_id: o.external_id,
            thread_key: o.thread_key,
            parent_id: o.parent_id ?? '',
            sent_at: o.sent_at,
            subject: o.subject,
        });
    }
    return { rows, badLines, lineNo };
}
// ---------------------------------------------------------------- анализ
function analyse(rows) {
    const byId = new Map();
    const duplicates = [];
    for (const r of rows) {
        if (byId.has(r.external_id))
            duplicates.push(r.external_id);
        else
            byId.set(r.external_id, r);
    }
    const threads = new Map();
    for (const r of byId.values()) {
        let list = threads.get(r.thread_key);
        if (!list)
            threads.set(r.thread_key, (list = []));
        list.push(r.external_id);
    }
    const withParent = [];
    const withoutParent = [];
    const unknownParent = [];
    const crossThread = [];
    const selfParent = [];
    for (const r of byId.values()) {
        if (!r.parent_id) {
            withoutParent.push(r);
            continue;
        }
        withParent.push(r);
        if (r.parent_id === r.external_id) {
            selfParent.push(r.external_id);
            continue;
        }
        const p = byId.get(r.parent_id);
        if (!p) {
            unknownParent.push({ child: r.external_id, parent: r.parent_id });
            continue;
        }
        if (p.thread_key !== r.thread_key) {
            crossThread.push({ child: r.external_id, parent: r.parent_id });
        }
    }
    // глубина и поиск циклов, обход без рекурсии
    const depth = new Map();
    const cycles = [];
    const WALKING = -1;
    for (const start of byId.keys()) {
        if (depth.has(start))
            continue;
        const path = [];
        let cur = start;
        while (cur !== undefined) {
            const known = depth.get(cur);
            if (known !== undefined) {
                if (known === WALKING) {
                    if (cycles.length < 20)
                        cycles.push(cur);
                    // разрываем цикл, чтобы обход завершился
                    for (const id of path)
                        depth.set(id, 1);
                    path.length = 0;
                }
                break;
            }
            depth.set(cur, WALKING);
            path.push(cur);
            const node = byId.get(cur);
            const parent = node.parent_id && node.parent_id !== cur ? byId.get(node.parent_id) : undefined;
            cur = parent?.external_id;
        }
        // раскручиваем накопленный путь от корня к листу
        let base = 0;
        if (path.length) {
            const last = byId.get(path[path.length - 1]);
            const parentOfLast = last.parent_id ? byId.get(last.parent_id) : undefined;
            base = parentOfLast ? depth.get(parentOfLast.external_id) ?? 0 : 0;
            if (base === WALKING)
                base = 0;
        }
        for (let i = path.length - 1; i >= 0; i--) {
            base += 1;
            depth.set(path[i], base);
        }
    }
    let longestChain = 0;
    for (const d of depth.values())
        if (d > longestChain)
            longestChain = d;
    const sizes = Array.from(threads.values(), (t) => t.length).sort((a, b) => b - a);
    const buckets = {
        single: sizes.filter((s) => s === 1).length,
        small: sizes.filter((s) => s >= 2 && s <= 10).length,
        medium: sizes.filter((s) => s >= 11 && s <= 50).length,
        large: sizes.filter((s) => s > 50).length,
    };
    return {
        unique: byId.size,
        duplicates,
        threads,
        sizes,
        buckets,
        withParent: withParent.length,
        withoutParent: withoutParent.length,
        unknownParent,
        crossThread,
        selfParent,
        cycles,
        longestChain,
        largestThread: sizes[0] ?? 0,
    };
}
// ---------------------------------------------------------------- замечания
function collectProblems(a, badLines) {
    const problems = [];
    const total = a.unique;
    const ex = (list) => list.slice(0, T.examples).join(', ');
    if (badLines.length) {
        problems.push({
            hard: true,
            title: `Строк с ошибками формата: ${num(badLines.length)}`,
            explanation: [
                `Например, строка ${badLines[0].line}: ${badLines[0].reason}.`,
                'Каждая строка файла должна быть отдельным объектом JSON с полями external_id, thread_key, parent_id, sent_at и subject. Эти строки в остальной подсчёт не вошли.',
            ],
        });
    }
    if (a.duplicates.length) {
        problems.push({
            hard: true,
            title: `Повторяющихся идентификаторов писем: ${num(a.duplicates.length)}`,
            explanation: [
                `Например: ${ex(a.duplicates)}.`,
                'Почтовый сервис отдаёт часть писем по нескольку раз на разных страницах, это его нормальное поведение. Запись в базу должна быть устроена так, чтобы повторное получение того же письма не создавало новую строку.',
                'В подсчётах ниже повторы учтены один раз.',
            ],
        });
    }
    if (a.selfParent.length) {
        problems.push({
            hard: true,
            title: `Писем, ссылающихся сами на себя: ${num(a.selfParent.length)}`,
            explanation: [
                `Например: ${ex(a.selfParent)}.`,
                'Поле parent_id должно указывать на другое письмо либо оставаться пустым.',
            ],
        });
    }
    if (a.unknownParent.length) {
        problems.push({
            hard: true,
            title: `Писем, у которых указан несуществующий родитель: ${num(a.unknownParent.length)}`,
            explanation: [
                `Например, письмо ${a.unknownParent[0].child} ссылается на ${a.unknownParent[0].parent}, которого в файле нет.`,
                'В поле references почтовый сервис указывает в том числе письма, которых в ленте нет. Такие ссылки нужно пропускать: в parent_id должно попадать только то письмо, которое действительно было получено.',
            ],
        });
    }
    if (a.crossThread.length) {
        problems.push({
            hard: true,
            title: `Писем, у которых родитель находится в другом разговоре: ${num(a.crossThread.length)}`,
            explanation: [
                `Например, письмо ${a.crossThread[0].child} и его родитель ${a.crossThread[0].parent} получили разные значения thread_key.`,
                'Это противоречие внутри самого файла: если одно письмо является ответом на другое, они по определению в одном разговоре.',
                'Обычная причина — разговоры собираются один раз при вставке письма и потом не пересматриваются. Письмо, пришедшее позже, может связать две ранее независимые переписки, и тогда их нужно объединить.',
            ],
        });
    }
    if (a.cycles.length) {
        problems.push({
            hard: true,
            title: `Обнаружены замкнутые цепочки ответов: ${num(a.cycles.length)}`,
            explanation: [
                `Например, начиная с письма ${a.cycles[0]}.`,
                'Двигаясь по parent_id, обход возвращается к уже пройденному письму. Цепочка ответов должна быть деревом и заканчиваться письмом с пустым parent_id.',
                'Частая причина — определение родителя по времени отправки. Время в этих данных ненадёжно: письма приходят в случайном порядке.',
            ],
        });
    }
    // --- подозрения по порогам ---
    if (total > 0 && a.largestThread / total > T.giantThreadShare) {
        problems.push({
            hard: false,
            title: `Один разговор содержит ${pct(a.largestThread, total)} всех писем`,
            explanation: [
                'Похоже, разные разговоры склеились между собой.',
                'Частая причина — объединение по теме письма или по участникам переписки. Тема к разговору отношения не имеет: у совершенно разных разговоров она бывает одинаковой, а внутри одного разговора она может меняться.',
                'Объединять письма нужно только по ссылкам: полю in_reply_to и элементам списка references.',
            ],
        });
    }
    const threadCount = a.threads.size;
    if (threadCount > 0 && a.buckets.single / threadCount > T.singletonShare) {
        problems.push({
            hard: false,
            title: `Разговоров из одного письма: ${pct(a.buckets.single, threadCount)}`,
            explanation: [
                'Похоже, связи между письмами восстановлены лишь частично.',
                'Стоит проверить два случая. Первый: у части писем поле in_reply_to отсутствует, и родителя нужно брать из последнего элемента списка references. Второй: письма приходят в случайном порядке, поэтому ответ нередко оказывается в базе раньше того письма, на которое он отвечает.',
            ],
        });
    }
    if (a.withParent === 0 && total > 1) {
        problems.push({
            hard: false,
            title: 'Ни у одного письма не заполнено поле parent_id',
            explanation: [
                'Поле parent_id должно содержать идентификатор письма, на которое отвечали, и остаётся пустым только у первого письма разговора.',
            ],
        });
    }
    if (total > 0 && total < T.suspiciouslyFewMessages) {
        problems.push({
            hard: false,
            title: `В файле всего ${num(total)} писем`,
            explanation: [
                'Похоже, обход ленты не дошёл до конца.',
                'Лента считается пройденной только тогда, когда в ответе пришло next_cursor равное null. Неполная страница признаком конца не является: сервис может вернуть меньше писем, чем запрошено, при непустом next_cursor.',
                'Также стоит проверить, что обход не прекращается при получении ошибки или при обрыве соединения.',
            ],
        });
    }
    if (a.longestChain <= 2 && total > 1000) {
        problems.push({
            hard: false,
            title: 'Самая длинная цепочка ответов состоит из двух писем',
            explanation: [
                'В данных есть переписки заметно большей глубины. Похоже, письма распределены по разговорам, но связь «ответ — на что отвечает» выстроена не до конца.',
            ],
        });
    }
    return problems;
}
// ---------------------------------------------------------------- запуск
async function main() {
    const path = process.argv[2];
    if (!path) {
        console.error('Укажите путь к файлу: node selfcheck.js out/result.jsonl');
        process.exit(2);
    }
    let read;
    try {
        read = await readRows(path);
    }
    catch (e) {
        console.error(`Не удалось прочитать файл ${path}: ${e.message}`);
        process.exit(2);
    }
    const { rows, badLines, lineNo } = read;
    if (rows.length === 0) {
        console.error(`Файл ${path} не содержит ни одной корректной строки.`);
        process.exit(2);
    }
    const a = analyse(rows);
    const problems = collectProblems(a, badLines);
    const total = a.unique;
    const threadCount = a.threads.size;
    console.log(`Файл: ${path}`);
    console.log(`Прочитано строк: ${num(lineNo)}`);
    section('ПИСЬМА');
    row('Всего строк с письмами', num(rows.length));
    row('Уникальных идентификаторов', num(total));
    row('Писем без родителя', num(a.withoutParent), pct(a.withoutParent, total));
    row('Писем с родителем', num(a.withParent), pct(a.withParent, total));
    section('РАЗГОВОРЫ');
    row('Всего разговоров', num(threadCount));
    row('Из одного письма', num(a.buckets.single), pct(a.buckets.single, threadCount));
    row('От 2 до 10 писем', num(a.buckets.small), pct(a.buckets.small, threadCount));
    row('От 11 до 50 писем', num(a.buckets.medium), pct(a.buckets.medium, threadCount));
    row('Более 50 писем', num(a.buckets.large), pct(a.buckets.large, threadCount));
    console.log('');
    row('Самый большой разговор', num(a.largestThread), 'писем');
    row('Самая длинная цепочка ответов', num(a.longestChain), 'писем');
    section('ЧТО ПРОВЕРЕНО');
    const hard = problems.filter((p) => p.hard);
    const soft = problems.filter((p) => !p.hard);
    const checks = [
        ['Все строки файла разобраны', badLines.length === 0],
        ['Повторяющихся идентификаторов нет', a.duplicates.length === 0],
        ['У каждого письма указан разговор', true],
        ['Все указанные родители есть в файле', a.unknownParent.length === 0 && a.selfParent.length === 0],
        ['Письмо и его родитель всегда в одном разговоре', a.crossThread.length === 0],
        ['Замкнутых цепочек ответов нет', a.cycles.length === 0],
    ];
    for (const [name, ok] of checks) {
        console.log(`  [${ok ? 'ок' : '!!'}]  ${name}`);
    }
    for (const p of soft) {
        console.log(`  [!!]  ${p.title}`);
    }
    if (problems.length) {
        section('ПОДРОБНО');
        for (const p of problems) {
            console.log('');
            console.log(`  ${p.title}`);
            for (const para of p.explanation) {
                console.log('');
                for (const line of wrap(para))
                    console.log(`    ${line}`);
            }
        }
    }
    const okCount = checks.filter(([, ok]) => ok).length;
    console.log('');
    if (problems.length === 0) {
        console.log(`Замечаний нет: ${okCount} из ${checks.length} пунктов пройдено.`);
    }
    else {
        console.log(`Пройдено ${okCount} из ${checks.length} пунктов, замечаний: ${num(problems.length)}.`);
    }
    console.log('');
    console.log('Этот скрипт не проверяет правильность результата. Он смотрит только на');
    console.log('внутреннюю согласованность файла. Отсутствие замечаний не означает, что');
    console.log('разговоры собраны верно.');
    process.exit(hard.length ? 1 : 0);
}
main().catch((e) => {
    console.error(e);
    process.exit(2);
});
