# lecroy-trc

[English](README.md) · Русский

Неофициальная библиотека для чтения осциллограмм Teledyne LeCroy в формате `.trc` в Node.js и браузере. Позволяет получить метаданные, прочитать отдельные сегменты Sequence и построить обзор графика с сохранением коротких пиков.

**Node.js ≥ 18.12.0** · **Типы TypeScript в пакете** · **Без зависимостей времени выполнения** · **[MIT](LICENSE)**

## Установка

Соберите локальный npm-архив командами из корня репозитория.

```sh
npm ci
npm pack
```

Установите в своём проекте архив, имя которого вывела команда `npm pack`.

```sh
npm install /path/to/lecroy-trc-0.2.0.tgz
```

## Быстрый старт

Сохраните пример как `read-trace.mjs` и запустите `node read-trace.mjs` рядом с файлом одиночной записи `C1.trc`.

```js
import { readFile } from 'node:fs/promises';
import { readTrcHeader, getSampleByteRange, decodeSamples } from 'lecroy-trc';

const file = await readFile('C1.trc');
const header = readTrcHeader(file);
const { start, endExclusive } = getSampleByteRange(header);
const { times, values } = decodeSamples(file.subarray(start, endExclusive), header);

console.log(header.instrumentName);
console.log({ samples: values.length, time: times[0], value: values[0] });
```

`times` и `values` — массивы `Float64Array`. Их единицы указаны в `header.horizontalUnit` и `header.verticalUnit`. В заголовке также доступны номер прибора, исходный код входа, масштаб, смещение и время триггера. Метка триггера хранится в файле без часового пояса.

В CommonJS используйте `require('lecroy-trc')`. TypeScript автоматически подхватывает декларации пакета. Среди доступных типов — `TrcHeader`, `TimeRange`, `SampleRange`, `SampleSeries` и `SegmentTiming`.

## Чтение по диапазону времени

По заголовку можно вычислить диапазон байтов до чтения отсчётов. Это подходит для локальных файлов, HTTP-запросов с заголовком `Range` и объектного хранилища.

```js
import { getSampleRangeForTime, getSampleByteRange } from 'lecroy-trc';

// Если горизонтальная шкала файла в секундах, границы можно задать в микросекундах.
const range = getSampleRangeForTime(header, { from: -2, to: 10 }, { timeScale: 1e6 });
const span = getSampleByteRange(header, range);
```

1. Прочитайте начало файла, содержащее весь дескриптор `WAVEDESC`, и передайте байты в `readTrcHeader`.
2. Выберите интервал времени. Обе границы времени включены. В диапазонах индексов и байтов конец исключён.
3. Для непустого диапазона запросите `bytes=${span.start}-${span.endExclusive - 1}` или прочитайте эти байты из локального файла. Заголовок и отсчёты должны относиться к одной версии файла.
4. Передайте прочитанные байты в `decodeSamples(bytes, header, range)`. Для обзора добавьте лимит интервалов, например `decodeSamples(bytes, header, range, 1_000)`.

При построении обзора библиотека сохраняет минимум и максимум каждого интервала с исходным временем и в порядке записи. Интервал с постоянным значением даёт одну точку. Без лимита возвращаются все выбранные отсчёты. Параметр `timeScale` задаёт единицы входных границ. Выходные временные метки остаются в единицах файла.

## Чтение сегментов Sequence

Сегменты нумеруются с нуля. В блоке `TRIGTIME` для каждого сегмента хранятся две временные величины в секундах. Чтобы запустить пример, скачайте [pulse_sequence.trc](https://raw.githubusercontent.com/lobis/lecroy-scope/2f627b418100d979c5a9b9dc9312fc275c534ce7/tests/files/pulse_sequence.trc).

```js
import { readFile } from 'node:fs/promises';
import {
  readTrcHeader, getSegmentTimingByteRange, decodeSegmentTiming,
  getSampleByteRange, decodeSamples,
} from 'lecroy-trc';

const file = await readFile('pulse_sequence.trc');
const header = readTrcHeader(file);
const slice = ({ start, endExclusive }) => file.subarray(start, endExclusive);

const index = 0;
const timing = decodeSegmentTiming(slice(getSegmentTimingByteRange(header, index)), header, index);
const span = getSampleByteRange(header, undefined, index);
const { times, values } = decodeSamples(slice(span), header, undefined, undefined, timing);

console.log({ triggerTime: timing.triggerTime, samples: values.length, firstTime: times[0] });
```

- `timing.triggerTime` — время от первого триггера в серии до триггера сегмента.
- `timing.triggerOffset` — время от триггера сегмента до его первого сохранённого отсчёта.
- `times[i]` — время относительно триггера сегмента. Для оси относительно первого триггера серии используйте `timing.triggerTime + times[i]`.
- Чтобы выбрать диапазон времени внутри сегмента, передайте `{ timing }` в `getSampleRangeForTime`, а в `getSampleByteRange` укажите индекс того же сегмента.

## Использование в браузере

Раздавайте `dist/browser/index.js` как JavaScript-модуль, например по адресу `/vendor/lecroy-trc.js`. Ему можно передать байты из объекта `File` или сетевого ответа.

```js
import { readTrcHeader } from '/vendor/lecroy-trc.js';

const header = readTrcHeader(new Uint8Array(await file.slice(0, 512).arrayBuffer()));
console.log(header.instrumentName);
```

В примере `file` — объект `File` из браузера. Если дескриптор выходит за первые 512 байт, прочитайте более длинный префикс. Для сборки модуля из исходников выполните `npm run build:browser`.

## Поддержка формата

| Возможность | Поддержка |
| --- | --- |
| Шаблон дескриптора | `LECROY_2_3` |
| Отсчёты | Знаковые 8- или 16-битные, little-endian или big-endian |
| Захват | Непрерывная одиночная запись и Sequence с одной записью `TRIGTIME` на сегмент |
| Остальные варианты | Чтение метаданных распознанного заголовка. Отсчёты RIS, разреженных записей и записей с двумя массивами выходят за рамки поддержки. |

При чтении незнакомого варианта проверьте `header.supportsSampleReading`. Если декодеру передать неполный диапазон байтов или запись неподдерживаемого вида, он вернёт ошибку `TrcFormatError`. Формат заголовка и формулы времени описаны в [руководстве Teledyne LeCroy](https://cdn.teledynelecroy.com/files/manuals/maui-remote-control-and-automation-manual.pdf#page=190).

## Разработка

```sh
npm ci
npm run typecheck
npm test
npm run test:upstream
npm pack --dry-run
```

Модульные тесты используют сгенерированные записи. Дополнительная проверка скачивает зафиксированный пример `pulse_sequence.trc` и сверяет 20 сегментов с результатами [lecroyscope 1.0.0](https://pypi.org/project/lecroyscope/1.0.0/). Для локальной копии выполните `npm run test:upstream -- /path/to/pulse_sequence.trc`.

Если файл читается некорректно, укажите модель прибора, шаблон дескриптора и по возможности приложите пример. Для развёртывания используйте [поддерживаемую LTS-ветку Node.js](https://nodejs.org/en/about/previous-releases).

## Лицензия

[MIT](LICENSE).
