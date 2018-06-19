/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

import React, { PureComponent } from 'react';
import classNames from 'classnames';
import { timeCode } from '../../utils/time-code';
import photonColors from 'photon-colors';

import type {
  Thread,
  CategoryList,
  IndexIntoSamplesTable,
  IndexIntoCategoryList,
} from '../../types/profile';
import {
  getSampleIndexClosestToTime,
  getSampleIndexClosestToTimeMatchingFilterFunction,
  FILTERED_OUT,
  BEFORE_SELECTED,
  SELECTED,
  AFTER_SELECTED,
} from '../../profile-logic/profile-data';
import type { Milliseconds } from '../../types/units';
import type {
  CallNodeInfo,
  IndexIntoCallNodeTable,
} from '../../types/profile-derived';

type Props = {|
  +fullThread: Thread,
  +interval: Milliseconds,
  +rangeStart: Milliseconds,
  +rangeEnd: Milliseconds,
  +callNodeInfo: CallNodeInfo,
  +selectedCallNodeIndex: IndexIntoCallNodeTable | null,
  +className: string,
  +onSampleClick: (sampleIndex: IndexIntoSamplesTable) => void,
  +categories: CategoryList,
  +selectedSamples?: boolean[],
|};

type Bucket = {|
  category: IndexIntoCategoryList,
  array: Float32Array,
  fillStyle: string | CanvasPattern,
|};

type PaintSettings = {|
  buckets: Bucket[],
  pixelWidth: number,
  pixelHeight: number,
  devicePixelRatio: number,
|};

function createDiagonalStripePattern(ctx, color) {
  const c = document.createElement('canvas');
  const dpr = Math.round(window.devicePixelRatio);
  c.width = 4 * dpr;
  c.height = 4 * dpr;
  const cctx = c.getContext('2d');
  cctx.scale(dpr, dpr);
  const linear = cctx.createLinearGradient(0, 0, 4, 4);
  linear.addColorStop(0, color);
  linear.addColorStop(0.25, color);
  linear.addColorStop(0.25, 'transparent');
  linear.addColorStop(0.5, 'transparent');
  linear.addColorStop(0.5, color);
  linear.addColorStop(0.75, color);
  linear.addColorStop(0.75, 'transparent');
  linear.addColorStop(1, 'transparent');
  cctx.fillStyle = linear;
  cctx.fillRect(0, 0, 4, 4);
  return ctx.createPattern(c, 'repeat');
}

class ThreadActivityGraph extends PureComponent<Props> {
  _canvas: null | HTMLCanvasElement;
  _lastPaintSettings: PaintSettings | null;
  _resizeListener: () => void;
  _takeCanvasRef = (canvas: HTMLCanvasElement | null) =>
    (this._canvas = canvas);

  constructor(props: Props) {
    super(props);
    this._resizeListener = () => this.forceUpdate();
    this._canvas = null;
    this._lastPaintSettings = null;
  }

  _renderCanvas() {
    const canvas = this._canvas;
    if (canvas !== null) {
      timeCode('ThreadActivityGraph render', () => {
        this.drawCanvas(canvas);
      });
    }
  }

  componentDidMount() {
    window.addEventListener('resize', this._resizeListener);
    this.forceUpdate(); // for initial size
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this._resizeListener);
  }

  drawCanvas(canvas: HTMLCanvasElement) {
    const {
      categories,
      fullThread,
      interval,
      rangeStart,
      rangeEnd,
      selectedSamples,
      // callNodeInfo,
      // selectedCallNodeIndex,
    } = this.props;
    const { samples, stackTable } = fullThread;

    const rangeLength = rangeEnd - rangeStart;

    const devicePixelRatio = canvas.ownerDocument
      ? canvas.ownerDocument.defaultView.devicePixelRatio
      : 1;
    const r = canvas.getBoundingClientRect();
    const pixelWidth = Math.round(r.width * devicePixelRatio);
    const pixelHeight = Math.round(r.height * devicePixelRatio);
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    const xPixelsPerMs = pixelWidth / rangeLength;

    const colorMap = {
      transparent: {
        selectedFillStyle: 'transparent',
        unselectedFillStyle: 'transparent',
        gravity: 0,
      },
      purple: {
        selectedFillStyle: photonColors.PURPLE_50,
        unselectedFillStyle: photonColors.PURPLE_50 + '60',
        gravity: 5,
      },
      green: {
        selectedFillStyle: photonColors.GREEN_60,
        unselectedFillStyle: photonColors.GREEN_60 + '60',
        gravity: 4,
      },
      orange: {
        selectedFillStyle: photonColors.ORANGE_60,
        unselectedFillStyle: photonColors.ORANGE_60 + '60',
        gravity: 2,
      },
      yellow: {
        selectedFillStyle: photonColors.YELLOW_60,
        unselectedFillStyle: photonColors.YELLOW_60 + '60',
        gravity: 6,
      },
      lightblue: {
        selectedFillStyle: photonColors.BLUE_40,
        unselectedFillStyle: photonColors.BLUE_40 + '60',
        gravity: 1,
      },
      grey: {
        selectedFillStyle: photonColors.GREY_40,
        unselectedFillStyle: photonColors.GREY_40 + '60',
        gravity: 8,
      },
      blue: {
        selectedFillStyle: photonColors.BLUE_60,
        unselectedFillStyle: photonColors.BLUE_60 + '60',
        gravity: 3,
      },
      brown: {
        selectedFillStyle: photonColors.MAGENTA_60,
        unselectedFillStyle: photonColors.MAGENTA_60 + '60',
        gravity: 7,
      },
    };

    const categoryInfos = categories.map(({ color: colorName }, category) => {
      const { selectedFillStyle, unselectedFillStyle, gravity } = colorMap[
        colorName
      ];
      const filteredOutFillStyle = createDiagonalStripePattern(
        ctx,
        unselectedFillStyle
      );
      return {
        category,
        gravity,
        selectedFillStyle,
        unselectedFillStyle,
        filteredOutFillStyle,
        beforeSelectedPercentageAtPixel: new Float32Array(pixelWidth),
        selectedPercentageAtPixel: new Float32Array(pixelWidth),
        afterSelectedPercentageAtPixel: new Float32Array(pixelWidth),
        filteredOutPercentageAtPixel: new Float32Array(pixelWidth),
      };
    });

    function pickselectedPercentage(categoryInfo, _sampleIndex) {
      return categoryInfo.selectedPercentageAtPixel;
    }

    function pickCategoryArrayWhenHaveSelectedSamples(
      categoryInfo,
      sampleIndex
    ) {
      if (!selectedSamples) {
        return categoryInfo.selectedPercentageAtPixel;
      }
      switch (selectedSamples[sampleIndex]) {
        case FILTERED_OUT:
          return categoryInfo.filteredOutPercentageAtPixel;
        case BEFORE_SELECTED:
          return categoryInfo.beforeSelectedPercentageAtPixel;
        case SELECTED:
          return categoryInfo.selectedPercentageAtPixel;
        case AFTER_SELECTED:
          return categoryInfo.afterSelectedPercentageAtPixel;
        default:
          throw new Error('Unexpected selectedSamples value');
      }
    }

    const pickCategoryArray = selectedSamples
      ? pickCategoryArrayWhenHaveSelectedSamples
      : pickselectedPercentage;

    const greyCategoryIndex =
      categories.findIndex(c => c.color === 'grey') || 0;

    function accumulateIntoCategory(
      category,
      sampleIndex,
      prevSampleTime,
      sampleTime,
      nextSampleTime
    ) {
      if (sampleTime < rangeStart || sampleTime >= rangeEnd) {
        return;
      }

      const categoryInfo = categoryInfos[category];
      if (categoryInfo.selectedFillStyle === 'transparent') {
        return;
      }

      const sampleStart = (prevSampleTime + sampleTime) / 2;
      const sampleEnd = (sampleTime + nextSampleTime) / 2;
      let pixelStart = (sampleStart - rangeStart) * xPixelsPerMs;
      let pixelEnd = (sampleEnd - rangeStart) * xPixelsPerMs;
      pixelStart = Math.max(0, pixelStart);
      pixelEnd = Math.min(pixelWidth - 1, pixelEnd);
      const intPixelStart = pixelStart | 0;
      const intPixelEnd = pixelEnd | 0;

      const categoryArray = pickCategoryArray(categoryInfo, sampleIndex);
      for (let i = intPixelStart; i <= intPixelEnd; i++) {
        categoryArray[i] += 1;
      }
      categoryArray[intPixelStart] -= pixelStart - intPixelStart;
      categoryArray[intPixelEnd] -= 1 - (pixelEnd - intPixelEnd);
    }

    let prevSampleTime = samples.time[0] - interval;
    let sampleTime = samples.time[0];
    for (let i = 0; i < samples.length - 1; i++) {
      const nextSampleTime = samples.time[i + 1];
      const stackIndex = samples.stack[i];
      const category =
        stackIndex !== null
          ? stackTable.category[stackIndex]
          : greyCategoryIndex;
      accumulateIntoCategory(
        category,
        i,
        prevSampleTime,
        sampleTime,
        nextSampleTime
      );
      prevSampleTime = sampleTime;
      sampleTime = nextSampleTime;
    }
    const lastSampleStack = samples.stack[samples.length - 1];
    const lastSampleCategory =
      lastSampleStack !== null
        ? stackTable.category[lastSampleStack]
        : greyCategoryIndex;
    accumulateIntoCategory(
      lastSampleCategory,
      samples.length - 1,
      prevSampleTime,
      sampleTime,
      sampleTime + interval
    );

    function boxBlur1D(srcArray, destArray, radius) {
      if (srcArray.length < radius) {
        destArray.set(srcArray);
        return;
      }

      // We treat values outside the range as zero.
      let total = 0;
      for (let kx = 0; kx <= radius; ++kx) {
        total += srcArray[kx];
      }
      destArray[0] = total / (radius * 2 + 1);

      for (let x = 1; x < radius + 1; ++x) {
        total += srcArray[x + radius];
        destArray[x] = total / (radius * 2 + 1);
      }
      for (let x = radius + 1; x < pixelWidth - radius; ++x) {
        total -= srcArray[x - radius - 1];
        total += srcArray[x + radius];
        destArray[x] = total / (radius * 2 + 1);
      }
      for (let x = pixelWidth - radius; x < pixelWidth; ++x) {
        total -= srcArray[x - radius - 1];
        destArray[x] = total / (radius * 2 + 1);
      }
    }

    let scratchArray = new Float32Array(pixelWidth);
    function gaussianBlur1D(srcArray) {
      const destArray = scratchArray;
      boxBlur1D(srcArray, destArray, 3);
      boxBlur1D(destArray, srcArray, 2);
      boxBlur1D(srcArray, destArray, 2);
      scratchArray = srcArray;
      return destArray;
    }

    categoryInfos.sort((a, b) => b.gravity - a.gravity);

    const individualBuckets = [].concat(
      ...categoryInfos.map(categoryInfo => [
        {
          category: categoryInfo.category,
          fillStyle: categoryInfo.unselectedFillStyle,
          array: gaussianBlur1D(categoryInfo.beforeSelectedPercentageAtPixel),
        },
        {
          category: categoryInfo.category,
          fillStyle: categoryInfo.selectedFillStyle,
          array: gaussianBlur1D(categoryInfo.selectedPercentageAtPixel),
        },
        {
          category: categoryInfo.category,
          fillStyle: categoryInfo.unselectedFillStyle,
          array: gaussianBlur1D(categoryInfo.afterSelectedPercentageAtPixel),
        },
        {
          category: categoryInfo.category,
          fillStyle: categoryInfo.filteredOutFillStyle,
          array: gaussianBlur1D(categoryInfo.filteredOutPercentageAtPixel),
        },
      ])
    );

    let lastCumulativeArray = individualBuckets[0].array;
    for (const { array } of individualBuckets.slice(1)) {
      for (let i = 0; i < pixelWidth; i++) {
        array[i] += lastCumulativeArray[i];
      }
      lastCumulativeArray = array;
    }

    function findNextDifferentIndex(arr1, arr2, startIndex) {
      for (let i = startIndex; i < arr1.length; i++) {
        if (arr1[i] !== arr2[i]) {
          return i;
        }
      }
      return arr1.length;
    }

    // Draw adjacent filled paths using Operator ADD and disjoint paths.
    // This avoids any bleeding and seams.
    // lighter === OP_ADD
    ctx.globalCompositeOperation = 'lighter';
    lastCumulativeArray = new Float32Array(pixelWidth);
    for (const { fillStyle, array } of individualBuckets) {
      const cumulativeArray = array;
      ctx.fillStyle = fillStyle;
      let lastNonZeroRangeEnd = 0;
      while (lastNonZeroRangeEnd < pixelWidth) {
        const currentNonZeroRangeStart = findNextDifferentIndex(
          cumulativeArray,
          lastCumulativeArray,
          lastNonZeroRangeEnd
        );
        if (currentNonZeroRangeStart >= pixelWidth) {
          break;
        }
        let currentNonZeroRangeEnd = pixelWidth;
        ctx.beginPath();
        ctx.moveTo(
          currentNonZeroRangeStart,
          (1 - lastCumulativeArray[currentNonZeroRangeStart]) * pixelHeight
        );
        for (let i = currentNonZeroRangeStart + 1; i < pixelWidth; i++) {
          const lastVal = lastCumulativeArray[i];
          const thisVal = cumulativeArray[i];
          ctx.lineTo(i, (1 - lastVal) * pixelHeight);
          if (lastVal === thisVal) {
            currentNonZeroRangeEnd = i;
            break;
          }
        }
        for (
          let i = currentNonZeroRangeEnd - 1;
          i >= currentNonZeroRangeStart;
          i--
        ) {
          ctx.lineTo(i, (1 - cumulativeArray[i]) * pixelHeight);
        }
        ctx.closePath();
        ctx.fill();

        lastNonZeroRangeEnd = currentNonZeroRangeEnd;
      }
      lastCumulativeArray = cumulativeArray;
    }

    this._lastPaintSettings = {
      buckets: individualBuckets,
      pixelWidth,
      pixelHeight,
      devicePixelRatio,
    };
  }

  _categoryAtPixel(x: number, y: number): IndexIntoCategoryList | null {
    const lastPaintSettings = this._lastPaintSettings;
    if (lastPaintSettings === null) {
      return null;
    }

    const {
      buckets,
      pixelWidth,
      pixelHeight,
      devicePixelRatio,
    } = lastPaintSettings;

    const deviceX = Math.round(x * devicePixelRatio);
    const deviceY = Math.round(y * devicePixelRatio);

    if (
      !buckets ||
      deviceX < 0 ||
      deviceX >= pixelWidth ||
      deviceY < 0 ||
      deviceY >= pixelHeight
    ) {
      return null;
    }

    const valueToFind = 1 - deviceY / pixelHeight;
    for (const { category, array } of buckets) {
      const thisBucketCumulativeValue = array[deviceX];
      if (thisBucketCumulativeValue >= valueToFind) {
        return category;
      }
    }

    return null;
  }

  _onMouseUp = (e: SyntheticMouseEvent<>) => {
    const canvas = this._canvas;
    if (canvas) {
      const { rangeStart, rangeEnd } = this.props;
      const r = canvas.getBoundingClientRect();

      const x = e.pageX - r.left;
      const y = e.pageY - r.top;
      const time = rangeStart + x / r.width * (rangeEnd - rangeStart);

      const clickedCategory = this._categoryAtPixel(x, y);

      const { fullThread, interval } = this.props;

      let sampleIndex = getSampleIndexClosestToTimeMatchingFilterFunction(
        fullThread.samples,
        time,
        interval,
        sampleIndex => {
          const stackIndex = fullThread.samples.stack[sampleIndex];
          return (
            stackIndex !== null &&
            fullThread.stackTable.category[stackIndex] === clickedCategory
          );
        }
      );

      if (sampleIndex === null) {
        sampleIndex = getSampleIndexClosestToTime(
          fullThread.samples,
          time,
          interval
        );
      }
      this.props.onSampleClick(sampleIndex);
    }
  };

  render() {
    this._renderCanvas();
    return (
      <div className={this.props.className}>
        <canvas
          className={classNames(
            `${this.props.className}Canvas`,
            'threadActivityGraphCanvas'
          )}
          ref={this._takeCanvasRef}
          onMouseUp={this._onMouseUp}
        />
      </div>
    );
  }
}

export default ThreadActivityGraph;
