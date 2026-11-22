# lecroy-trc

[English](README.md) · Русский

Неофициальная библиотека для чтения файлов Teledyne LeCroy `.trc` в Node.js и браузере. Читает одиночные записи и сегменты Sequence, выбирает отсчёты по времени и сохраняет минимумы и максимумы для обзорного графика.

**Node.js ≥ 18.12.0** · **Типы TypeScript в пакете** · **Без зависимостей** · **[MIT](LICENSE)**

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

В CommonJS используйте `require('lecroy-trc')`. TypeScript подхватывает [типы](#типы-и-ошибки) из пакета.

## Чтение по диапазону времени

По заголовку можно вычислить диапазон байтов до чтения отсчётов. Это подходит для локальных файлов, HTTP-запросов с заголовком `Range` и объектного хранилища.

```js
import { getSampleRangeForTime, getSampleByteRange } from 'lecroy-trc';

// Если горизонтальная шкала файла в секундах, границы можно задать в микросекундах.
const range = getSampleRangeForTime(header, { from: -2, to: 10 }, { timeScale: 1e6 });
const span = getSampleByteRange(header, range);
```

1. Передайте начало файла с [полями WAVEDESC](#readtrcheader) в `readTrcHeader`.
2. Найдите `range` и `span` по заголовку, как в примере выше.
3. Для непустого диапазона запросите `bytes=${span.start}-${span.endExclusive - 1}` или прочитайте эти байты из локального файла. Заголовок и отсчёты должны относиться к одной версии файла.
4. Передайте прочитанные байты в `decodeSamples(bytes, header, range)`. Для обзора добавьте лимит интервалов, например `decodeSamples(bytes, header, range, 1_000)`.

## Чтение сегментов Sequence

Сегменты нумеруются с нуля. В блоке `TRIGTIME` для каждого сегмента хранятся две временные величины в секундах. Для запуска примера сохраните запись Sequence под именем `pulse_sequence.trc`.

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

Чтобы прочитать часть сегмента, передайте его `timing` в [getSampleRangeForTime](#getsamplerangefortime).

## Использование в браузере

Если проект использует сборщик, импортируйте из `lecroy-trc`, как в быстром старте.

На странице без сборщика подключите свой скрипт через `<script type="module">`. Скопируйте `dist/browser/index.js` рядом с этим скриптом под именем `lecroy-trc.js`.

```js
import { readTrcHeader } from './lecroy-trc.js';

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

Формат заголовка и формулы времени описаны в [руководстве Teledyne LeCroy](https://cdn.teledynelecroy.com/files/manuals/maui-remote-control-and-automation-manual.pdf#page=190).

## API

### `readTrcHeader`

```ts
readTrcHeader(bytes: Uint8Array): TrcHeader
```

Читает заголовок из файла или его начала. Передайте байты с начала файла до конца 346-байтовой области полей `WAVEDESC`. В Node.js можно передать `Buffer`. В `supportsSampleReading` указано, поддерживает ли библиотека декодирование этой записи. Отсчёты и блок времени можно прочитать позже.

Бросает `TrcFormatError`, если дескриптор отсутствует, обрезан, повреждён или использует неподдерживаемый формат.

### `getSampleRangeForTime`

```ts
getSampleRangeForTime(
  header: TrcHeader,
  range: TimeRange,
  options?: { timing?: SegmentTiming; timeScale?: number },
): SampleRange
```

Выбирает валидные отсчёты от `from` до `to` включительно. Границы могут совпадать. Если в интервале нет отсчётов, функция возвращает диапазон с `start === endExclusive`.

По умолчанию границы задаются в единицах горизонтальной шкалы файла. С параметром `timeScale` функция умножает время отсчёта на этот коэффициент перед сравнением. Например, `1e6` позволяет задать границы в микросекундах для файла со шкалой в секундах. Для Sequence передайте `timing` выбранного сегмента. Время отсчитывается от его триггера, а индексы — от начала сегмента.

Границы должны быть конечными числами в порядке `from ≤ to`, а `timeScale` — конечным числом больше нуля. Нарушение этих условий или неверный индекс сегмента даёт `RangeError`. При неподдерживаемой структуре записи, лишнем или отсутствующем `timing` либо неверном смещении возникает `TrcFormatError`.

### `getSampleByteRange`

```ts
getSampleByteRange(header: TrcHeader, range?: SampleRange, segmentIndex?: number): SampleRange
```

Переводит индексы отсчётов в смещения байтов от начала файла. Для Sequence укажите `segmentIndex` с нуля и задавайте `range` относительно начала сегмента. Для одиночной записи можно опустить индекс или передать `0`. Без `range` функция выбирает все валидные отсчёты записи или сегмента.

Бросает `RangeError` при неверном индексе сегмента или диапазоне отсчётов. Для диапазона нужны целые индексы в порядке возрастания или равные границы внутри допустимой области. Неподдерживаемая структура записи или отсутствие индекса для Sequence вызывает `TrcFormatError`.

### `decodeSamples`

```ts
decodeSamples(
  bytes: Uint8Array,
  header: TrcHeader,
  range?: SampleRange,
  buckets?: number,
  timing?: SegmentTiming,
): SampleSeries
```

Принимает ровно те байты, которые указал `getSampleByteRange` для той же выборки. Без `range` берёт все валидные отсчёты записи или сегмента. Для Sequence передайте `timing`, для одиночной записи опустите его. Пустому диапазону соответствует пустой буфер и два пустых массива.

`values` содержит значения `raw * verticalGain - verticalOffset` в единицах `header.verticalUnit`. `times` содержит время в единицах `header.horizontalUnit`, для Sequence — относительно триггера сегмента. `timeScale` влияет только на выборку.

Без `buckets` возвращаются все выбранные отсчёты. Если передать целое число от 1 до `Number.MAX_SAFE_INTEGER`, результат содержит до `2 * buckets` точек. Для каждого интервала функция возвращает минимум и максимум с исходным временем, в порядке записи. Интервал с постоянным значением даёт одну точку.

Бросает `RangeError` при неверном диапазоне, индексе сегмента или количестве интервалов. При неподдерживаемой структуре записи, неверном числе байтов, лишнем или отсутствующем `timing` либо неверном смещении возникает `TrcFormatError`.

### `getSegmentTimingByteRange`

```ts
getSegmentTimingByteRange(header: TrcHeader, segmentIndex: number): SampleRange
```

Возвращает смещения 16-байтовой записи в `TRIGTIME` от начала файла. Передайте индекс сегмента с нуля. В Sequence должна быть одна запись времени на каждый захваченный сегмент. Функция может найти запись, даже если `supportsSampleReading` равен `false`.

Бросает `TrcFormatError` при несовпадении формата блока времени и `RangeError` при неверном индексе.

### `decodeSegmentTiming`

```ts
decodeSegmentTiming(bytes: Uint8Array, header: TrcHeader, segmentIndex: number): SegmentTiming
```

Принимает ровно 16 байт по смещениям из `getSegmentTimingByteRange`. Читает два 64-битных числа с плавающей точкой в порядке байтов из заголовка. Оба значения в секундах.

- `triggerTime` — время от первого триггера серии до триггера сегмента.
- `triggerOffset` — время от триггера сегмента до его первого сохранённого отсчёта.

Для общей оси серии прибавьте `triggerTime` ко времени каждого отсчёта сегмента в секундах. Формат и индекс проверяются так же, как в `getSegmentTimingByteRange`. Неверная длина среза, бесконечность или `NaN` в данных дают `TrcFormatError`.

### Типы и ошибки

| Экспорт | Поля |
| --- | --- |
| `TrcHeader` | Разобранный дескриптор. Поля перечислены ниже. |
| `TimeRange` | `{ from, to }`. Обе границы времени включены. |
| `SampleRange` | `{ start, endExclusive }`. В зависимости от функции это индексы отсчётов или смещения байтов. Конец исключён. |
| `SampleSeries` | `{ times, values }`. Два массива `Float64Array` одинаковой длины. |
| `SegmentTiming` | `{ segmentIndex, triggerTime, triggerOffset }`. |
| `TrcFormatError` | Класс ошибки с конструктором `new TrcFormatError(message: string)`. Тип ошибки можно проверить через `instanceof TrcFormatError`. |

| Поля `TrcHeader` | Значение |
| --- | --- |
| `template`, `recordType`, `supportsSampleReading` | Шаблон дескриптора, код типа записи и признак поддержки декодирования отсчётов. |
| `instrumentName`, `instrumentNumber`, `traceLabel`, `waveSource` | Идентификаторы прибора и сигнала. `waveSource` хранит исходный код входа. Аналоговые C1–C4 имеют коды 0–3. |
| `trigger` | Локальное время прибора без часового пояса с полями `year`, `month`, `day`, `hour`, `minute`, `second`. Секунды могут быть дробными. |
| `littleEndian`, `bytesPerSample` | Порядок байтов и ширина отсчёта в 1 или 2 байта. |
| `dataOffset`, `dataLength` | Смещение от начала файла и длина основного массива отсчётов в байтах. |
| `sampleCount`, `firstValidSample`, `lastValidSample` | Число отсчётов и границы валидных данных в полном хранимом массиве. Последний индекс включён. |
| `isSequence`, `segmentCount`, `samplesPerSegment` | Признак Sequence, число захваченных сегментов и число сохранённых отсчётов на сегмент. |
| `segmentTimingOffset`, `segmentTimingLength` | Смещение и длина блока `TRIGTIME` в байтах. |
| `horizontalInterval`, `horizontalOffset`, `horizontalUnit` | Шаг отсчётов, смещение из дескриптора и единица горизонтальной шкалы. При декодировании сегмента используется его `triggerOffset`. |
| `verticalGain`, `verticalOffset`, `verticalUnit` | Масштаб, смещение и единица вертикальной шкалы для перевода исходных отсчётов. |

## Разработка

```sh
npm ci
npm run typecheck
npm test
npm run test:upstream
npm pack --dry-run
```

Модульные тесты используют сгенерированные записи. Дополнительная проверка скачивает фиксированный образец `pulse_sequence.trc` и сверяет отсчёты и время всех 20 сегментов с сохранённым эталоном. Для локальной копии выполните `npm run test:upstream -- /path/to/pulse_sequence.trc`.

Если файл читается некорректно, укажите модель прибора, шаблон дескриптора и по возможности приложите пример. Для развёртывания используйте [поддерживаемую LTS-ветку Node.js](https://nodejs.org/en/about/previous-releases).

## Лицензия

[MIT](LICENSE).
