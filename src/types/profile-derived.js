/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import type { Milliseconds, StartEndRange, Address, Bytes } from './units';
import type { MarkerPayload, MarkerSchema } from './markers';
import type {
  ThreadIndex,
  Thread,
  Pid,
  IndexIntoFuncTable,
  IndexIntoJsTracerEvents,
  IndexIntoCategoryList,
  IndexIntoResourceTable,
  IndexIntoNativeSymbolTable,
  IndexIntoLibs,
  CounterIndex,
  InnerWindowID,
  Page,
  IndexIntoRawMarkerTable,
  IndexIntoStringTable,
  TabID,
  Tid,
} from './profile';
import type { IndexedArray } from './utils';
import type { StackTiming } from '../profile-logic/stack-timing';
export type IndexIntoCallNodeTable = number;

/**
 * Contains a table of function call information that represents the stacks of what
 * functions were called, as opposed to stacks based on frames. There can be multiple
 * frames for a single function call. Using stacks as opposed to a computed tree of
 * CallNodes can cause duplicated functions in the call tree.
 *
 * For example:
 *
 *            stack1 (funcA)                             callNode1 (funcA)
 *                 |                                            |
 *                 v                                            v
 *            stack2 (funcB)         StackTable to       callNode2 (funcB)
 *                 |                 CallNodeTable              |
 *                 v                      ->                    v
 *            stack3 (funcC)                             callNode3 (funcC)
 *            /            \                                    |
 *           V              V                                   v
 *    stack4 (funcD)     stack5 (funcD)                  callNode4 (funcD)
 *         |                  |                          /               \
 *         v                  V                         V                 V
 *    stack6 (funcE)     stack7 (funcF)       callNode5 (funcE)     callNode6 (funcF)
 *
 * For a detailed explanation of callNodes see `docs-developer/call-tree.md` and
 * `docs-developer/call-nodes-in-cpp.md`.
 *
 * # Call node ordering
 *
 * Call nodes are ordered in depth-first traversal order. This makes it super fast
 * to check whether node A is a descendant of node B, because all subtrees are
 * a contiguous range of call node indexes.
 *
 * More details about the ordering:
 *
 *  - The node at index 0 is the first root node.
 *  - If a node A has children, then A + 1 is its first child.
 *  - If a node A has no children, then A + 1 is its next sibling, or the closest
 *    next sibling of an ancestor node if A doesn't have a next sibling.
 *  - For every node A, there's a single "index range" which contains this node
 *    and all its descendants: [A, callNodeTable.subtreeRangeEnd[A]).
 *  - This "tree of ranges" is well-nested.
 *  - The ordering of siblings doesn't have any meaning, i.e. it doesn't matter
 *    if a node is the first or the third child of its parent (they're not
 *    ordered by func or anything).
 *
 * Example:
 *
 * ```
 *  - 0 funcG
 *    - 1 funcH
 *      - 2 funcI
 *      - 3 funcG
 *    - 4 funcJ
 *    - 5 funcI
 *  - 6 funcK
 *    - 7 funcG
 *      - 8 funcL
 *  - 9 funcH
 * ```
 *
 * In this example, the index range of the subtree of node 0 is [0, 6).
 * The index range of the subtree of node 3 is [3, 4), i.e. the half-open range
 * which only contains node 3.
 */
export type CallNodeTable = {
  // The index of the parent call node, or -1 for root nodes.
  prefix: Int32Array, // IndexIntoCallNodeTable -> IndexIntoCallNodeTable | -1

  // The index of this node's next sibling, or -1 if this node is the last child / last root.
  nextSibling: Int32Array, // IndexIntoCallNodeTable -> IndexIntoCallNodeTable | -1

  // The index after this node's last descendant. If this node has a next sibling,
  // subtreeRangeEnd is equal to nextSibling. Otherwise, this is the index
  // of the next sibling of the closest ancestor node which has a next sibling.
  // The last node has subtreeRangeEnd set to callNodeTable.length.
  //
  // The nodes in the range range [A, subtreeRangeEnd[A]) form A's subtree.
  subtreeRangeEnd: Uint32Array, // IndexIntoCallNodeTable -> IndexIntoCallNodeTable

  func: Int32Array, // IndexIntoCallNodeTable -> IndexIntoFuncTable
  category: Int32Array, // IndexIntoCallNodeTable -> IndexIntoCategoryList
  subcategory: Int32Array, // IndexIntoCallNodeTable -> IndexIntoSubcategoryListForCategory
  innerWindowID: Float64Array, // IndexIntoCallNodeTable -> InnerWindowID
  // null: no inlining
  // IndexIntoNativeSymbolTable: all frames that collapsed into this call node inlined into the same native symbol
  // -1: divergent: not all frames that collapsed into this call node were inlined, or they are from different symbols
  sourceFramesInlinedIntoSymbol: Array<IndexIntoNativeSymbolTable | -1 | null>,
  // The depth of the call node. Roots have depth 0.
  depth: number[],
  // The maximum value in the depth column, or -1 if this table is empty.
  maxDepth: number,
  // The number of call nodes. All columns in this table have this length.
  length: number,
};

/**
 * Wraps the call node table and provides associated functionality.
 */
export interface CallNodeInfo {
  // If true, call node indexes describe nodes in the inverted call tree.
  isInverted(): boolean;

  // Returns the call node table. If isInverted() is true, this is an inverted
  // call node table, otherwise this is the non-inverted call node table.
  getCallNodeTable(): CallNodeTable;

  // Returns the non-inverted call node table.
  // This is always the non-inverted call node table, regardless of isInverted().
  getNonInvertedCallNodeTable(): CallNodeTable;

  // Returns a mapping from the stack table to the call node table.
  // The Int32Array should be used as if it were a
  // Map<IndexIntoStackTable, IndexIntoCallNodeTable | -1>.
  //
  // If this CallNodeInfo is for the non-inverted tree, this maps the stack index
  // to its corresponding call node index, and all entries are >= 0.
  // If this CallNodeInfo is for the inverted tree, this maps the non-inverted
  // stack index to the inverted call node index. For example, the stack
  // A -> B -> C -> D is mapped to the inverted call node describing the
  // call path D <- C <- B <- A, i.e. the node with function A under the D root
  // of the inverted tree. Stacks which are only used as prefixes are not mapped
  // to an inverted call node; for those, the entry will be -1. In the example
  // above, if the stack node A -> B -> C only exists so that it can be the prefix
  // of the A -> B -> C -> D stack and no sample / marker / allocation has
  // A -> B -> C as its stack, then there is no need to have a call node
  // C <- B <- A in the inverted call node table.
  getStackIndexToCallNodeIndex(): Int32Array;

  // Returns a mapping from the stack table to the non-inverted call node table.
  // This always maps to the non-inverted call node table, regardless of isInverted().
  getStackIndexToNonInvertedCallNodeIndex(): Int32Array;

  // Converts a call node index into a call node path.
  getCallNodePathFromIndex(
    callNodeIndex: IndexIntoCallNodeTable | null
  ): CallNodePath;

  // Converts a call node path into a call node index.
  getCallNodeIndexFromPath(
    callNodePath: CallNodePath
  ): IndexIntoCallNodeTable | null;

  // Returns the call node index that matches the function `func` and whose
  // parent's index  is `parent`. If `parent` is -1, this returns the index of
  // the root node with function `func`.
  // Returns null if the described call node doesn't exist.
  getCallNodeIndexFromParentAndFunc(
    parent: IndexIntoCallNodeTable | -1,
    func: IndexIntoFuncTable
  ): IndexIntoCallNodeTable | null;
}

export type LineNumber = number;

// Stores the line numbers which are hit by each stack, for one specific source
// file.
// Used to compute LineTimings in combination with a SamplesLikeTable.
//
// StackLineInfo can be computed once for a filtered thread. Then it is reused
// for the computation of different LineTimings as the preview selection changes.
//
// The order of these arrays is the same as the order of thread.stackTable;
// the array index is a stackIndex. Not all stacks are guaranteed to have a useful
// value; only stacks which are used as "self" stacks, i.e. stacks which are used
// in thread.samples.stack or in marker stacks / allocation stacks, are required
// to have their values computed - only these values will be accessed during the
// LineTimings computation.
//
// For stacks which are only used as prefix stack nodes, selfLine and
// stackLine may be null. This is fine because their values are not accessed
// during the LineTimings computation.
export type StackLineInfo = {|
  // An array that contains, for each "self" stack, the line number that this stack
  // spends its self time in, in this file, or null if the self time of the
  // stack is in a different file or if the line number is not known.
  // For non-"self" stacks, i.e. stacks which are only used as prefix stacks and
  // never referred to from a SamplesLikeTable, the value may be null.
  selfLine: Array<LineNumber | null>,
  // An array that contains, for each "self" stack, all the lines that the frames in
  // this stack hit in this file, or null if this stack does not hit any line
  // in the given file.
  // For non-"self" stacks, i.e. stacks which are only used as prefix stacks and
  // never referred to from a SamplesLikeTable, the value may be null.
  stackLines: Array<Set<LineNumber> | null>,
|};

// Stores, for all lines of one specific file, how many times each line is hit
// by samples in a thread. The maps only contain non-zero values.
// So map.get(line) === undefined should be treated as zero.
export type LineTimings = {|
  totalLineHits: Map<LineNumber, number>,
  selfLineHits: Map<LineNumber, number>,
|};

// Stores the addresses which are hit by each stack, for addresses belonging to
// one specific native symbol.
// Used to compute AddressTimings in combination with a SamplesLikeTable.
//
// StackAddressInfo can be computed once for a filtered thread. Then it is reused
// for the computation of different AddressTimings as the preview selection changes.
//
// The order of these arrays is the same as the order of thread.stackTable;
// the array index is a stackIndex. Not all stacks are guaranteed to have a useful
// value; only stacks which are used as "self" stacks, i.e. stacks which are used
// in thread.samples.stack or in marker stacks / allocation stacks, are required
// to have their values computed - only these values will be accessed during the
// AddressTimings computation.
//
// For stacks which are only used as prefix stack nodes, selfAddress and
// stackAddress may be null. This is fine because their values are not accessed
// during the AddressTimings computation.
export type StackAddressInfo = {|
  // An array that contains, for each "self" stack, the address that this stack
  // spends its self time in, in this native symbol, or null if the self time of
  // the stack is in a different native symbol or if the address is not known.
  // For non-"self" stacks, i.e. stacks which are only used as prefix stacks and
  // never referred to from a SamplesLikeTable, the value may be null.
  selfAddress: Array<Address | null>,
  // An array that contains, for each "self" stack, all the addresses that the
  // frames in this stack hit in this native symbol, or null if this stack does
  // not hit any address in the given native symbol.
  // For non-"self" stacks, i.e. stacks which are only used as prefix stacks and
  // never referred to from a SamplesLikeTable, the value may be null.
  stackAddresses: Array<Set<Address> | null>,
|};

// Stores, for all addresses of one specific library, how many times each
// address is hit by samples in a thread. The maps only contain non-zero values.
// So map.get(address) === undefined should be treated as zero.
export type AddressTimings = {|
  totalAddressHits: Map<Address, number>,
  selfAddressHits: Map<Address, number>,
|};

// Stores the information that's needed to prove to the symbolication API that
// we are authorized to request the source code for a specific file.
// This "address proof" makes it easy for the browser (or local symbol server)
// to limit file access to only the set of files which are referenced by trusted
// symbol information, without forcing the browser (or local symbol server) to
// build a full list of such files upfront. Building a full list would take a
// long time - up to a minute. Checking individual addresses is much faster.
//
// By allowing access to only the files referenced by symbol information, we
// avoid giving malicious actors the ability to read arbitrary files.
// Specifically, this restriction protects against the following threats:
//  - If source code is requested from the browser via the WebChannel, the check
//    avoids exposing arbitrary files to a compromised profiler.firefox.com web
//    page or to a compromised profiler.firefox.com content process. So the
//    check only makes a difference in cases where the browser can no longer
//    trust the profiler WebChannel.
//  - If source code is requested from a local symbol server via an HTTP
//    request, the check avoids exposing arbitrary files to a compromised
//    profiler.firefox.com page, or to other web pages or outside actors who
//    have guessed the correct URL to request source code from. Symbol servers
//    will usually put a randomized token into the URL in order to make it even
//    harder to guess the right URL. The address proof check is an extra layer
//    of protection on top of that, in case the secret URL somehow leaks.
export type AddressProof = {|
  // The debugName of a library whose symbol information refers to the requested
  // file.
  debugName: string,
  // The breakpadId of that library.
  breakpadId: string,
  // The address in that library for which the symbolicated frames refer to the
  // requested file.
  address: Address,
|};

/**
 * When working with call trees, individual nodes in the tree are not stable across
 * different types of transformations and filtering operations. In order to refer
 * to some place in the call tree we use a list of functions that either go from
 * root to tip for normal call trees, or from tip to root for inverted call trees.
 * These paths are then stored along with the implementation filter, and the whether
 * or not the tree is inverted for a stable reference into a call tree.
 *
 * In some parts of the code the term prefix path is used to refer to a CallNodePath that
 * goes from root to tip, and the term postfix path is used to refer to a CallNodePath
 * that goes from tip to root.
 */
export type CallNodePath = IndexIntoFuncTable[];

export type CallNodeAndCategory = {|
  func: IndexIntoFuncTable,
  category: IndexIntoCategoryList,
|};

export type CallNodeAndCategoryPath = CallNodeAndCategory[];

/**
 * This type contains the first derived `Marker[]` information, plus an IndexedArray
 * to get back to the RawMarkerTable.
 */
export type DerivedMarkerInfo = {|
  markers: Marker[],
  markerIndexToRawMarkerIndexes: IndexedArray<
    MarkerIndex,
    IndexIntoRawMarkerTable[],
  >,
|};

export type Marker = {|
  start: Milliseconds,
  end: Milliseconds | null,
  name: string,
  category: IndexIntoCategoryList,
  threadId: Tid | null,
  data: MarkerPayload | null,
  incomplete?: boolean,
|};

/**
 * A value with this type uniquely identifies a marker. This is the index of a
 * marker in the full marker list (as returned by the selector `getFullMarkerList`),
 * and the marker object is returned using the function `getMarker` as returned
 * by the selector `getMarkerGetter`:
 *
 *   const getMarker = selectedThreadSelectors.getMarkerGetter(state);
 *   const marker = getMarker(markerIndex);
 */
export type MarkerIndex = number;

export type CallNodeData = {
  funcName: string,
  total: number,
  totalRelative: number,
  self: number,
  selfRelative: number,
};

export type ExtraBadgeInfo = {|
  name: string,
  localizationId: string,
  vars: mixed,
  titleFallback: string,
  contentFallback: string,
|};

export type CallNodeDisplayData = $Exact<
  $ReadOnly<{
    total: string,
    totalWithUnit: string,
    totalPercent: string,
    self: string,
    selfWithUnit: string,
    name: string,
    lib: string,
    isFrameLabel: boolean,
    categoryName: string,
    categoryColor: string,
    iconSrc: string | null,
    badge?: ExtraBadgeInfo,
    icon: string | null,
    ariaLabel: string,
  }>,
>;

export type ThreadWithReservedFunctions = {|
  thread: Thread,
  reservedFunctionsForResources: Map<
    IndexIntoResourceTable,
    IndexIntoFuncTable,
  >,
|};

/**
 * The marker timing contains the necessary information to draw markers very quickly
 * in the marker chart. It represents a single row of markers in the chart.
 */
export type MarkerTiming = {|
  // Start time in milliseconds.
  start: number[],
  // End time in milliseconds. It will equals start for instant markers.
  end: number[],
  index: MarkerIndex[],
  name: string,
  bucket: string,
  // True if this marker timing contains only instant markers.
  instantOnly: boolean,
  length: number,
|};

export type MarkerTimingRows = Array<MarkerTiming>;

/**
 * Combined timing can be used in the Stack Chart. When this happens, the chart will
 * either take both marker timing and stack timing, or just the stack timing information.
 * This way, UserTiming markers can be shown together with the stack information.
 */
export type CombinedTimingRows =
  | Array<MarkerTiming | StackTiming>
  | Array<StackTiming>;

/**
 * This type contains the necessary information to fully draw the marker chart. Each
 * entry in the array represents a single fixed height row in the chart. The MarkerTiming
 * represents the markers, and a bare string represents a marker "bucket". It is drawn
 * as a single row in the marker chart, and serves as a separator between different
 * areas. This flat array structure was chosen because it makes it really easy to
 * loop through each row, and only draw the current subset on the screen.
 */
export type MarkerTimingAndBuckets = Array<MarkerTiming | string>;

export type JsTracerTiming = {
  // Start time in milliseconds.
  start: number[],
  // End time in milliseconds.
  end: number[],
  index: IndexIntoJsTracerEvents[],
  label: string[],
  name: string,
  func: Array<IndexIntoFuncTable | null>,
  length: number,
};

/**
 * The memory counter sometimes contains relative offsets of memory. This type provides a data
 * structure that can be used to see the total range of change over all the samples,
 */
export type CounterSummary = {|
  +minCount: number,
  +maxCount: number,
  +countRange: number,
  // If present this value holds the accumulation of all the previous counts
  // in the Counter samples.  For a relative memory counter, this gives the
  // relative offset of bytes in that range selection. The array will share
  // the indexes of the range filtered counter samples.
  +accumulatedCounts: ?(number[]),
|};

/**
 * A collection of the data for all configured lines for a given marker
 */
export type CollectedCustomMarkerSamples = {|
  +minNumber: number,
  +maxNumber: number,
  // This value holds the number per configured line
  // selection. The array will share the indexes of the range filtered marker samples.
  +numbersPerLine: number[][],
  +markerIndexes: MarkerIndex[],
|};

export type StackType = 'js' | 'native' | 'unsymbolicated';

export type GlobalTrack =
  // mainThreadIndex is null when this is a fake global process added to contain
  // real threads.
  | {| +type: 'process', +pid: Pid, +mainThreadIndex: ThreadIndex | null |}
  | {| +type: 'screenshots', +id: string, +threadIndex: ThreadIndex |}
  | {| +type: 'visual-progress' |}
  | {| +type: 'perceptual-visual-progress' |}
  | {| +type: 'contentful-visual-progress' |};

export type LocalTrack =
  | {| +type: 'thread', +threadIndex: ThreadIndex |}
  | {| +type: 'network', +threadIndex: ThreadIndex |}
  | {| +type: 'memory', +counterIndex: CounterIndex |}
  | {| +type: 'bandwidth', +counterIndex: CounterIndex |}
  | {| +type: 'ipc', +threadIndex: ThreadIndex |}
  | {| +type: 'event-delay', +threadIndex: ThreadIndex |}
  | {| +type: 'process-cpu', +counterIndex: CounterIndex |}
  | {| +type: 'power', +counterIndex: CounterIndex |}
  | {|
      +type: 'marker',
      +threadIndex: ThreadIndex,
      +markerSchema: MarkerSchema,
      +markerName: IndexIntoStringTable,
    |};

export type Track = GlobalTrack | LocalTrack;

// A track index doesn't always represent uniquely a track: it's merely an index inside
// a specific structure:
// - for global tracks, this is the index in the global tracks array
// - for local tracks, this is the index in the local tracks array for a specific pid.
export type TrackIndex = number;

/**
 * The origins timeline view is experimental. These data structures may need to be
 * adjusted to fit closer to the other track types, but they were easy to do for now.
 */

/**
 * This origin was loaded as a sub-frame to another one. It will be nested in the view.
 */
export type OriginsTimelineEntry = {|
  type: 'sub-origin',
  innerWindowID: InnerWindowID,
  threadIndex: ThreadIndex,
  page: Page,
  origin: string,
|};

/**
 * This is a "root" origin, which is viewed at the top level in a tab.
 */
export type OriginsTimelineRoot = {|
  type: 'origin',
  innerWindowID: InnerWindowID,
  threadIndex: ThreadIndex,
  page: Page,
  origin: string,
  children: Array<OriginsTimelineEntry | OriginsTimelineNoOrigin>,
|};

/**
 * This thread does not have any origin information associated with it. However
 * it may be listed as a child of another "root" timeline origin if it is in the
 * same process as that thread.
 */
export type OriginsTimelineNoOrigin = {|
  type: 'no-origin',
  threadIndex: ThreadIndex,
|};

export type OriginsTimelineTrack =
  | OriginsTimelineEntry
  | OriginsTimelineRoot
  | OriginsTimelineNoOrigin;

export type OriginsTimeline = Array<
  OriginsTimelineNoOrigin | OriginsTimelineRoot,
>;

/**
 * Active tab view tracks
 */

/**
 * Main track for active tab view.
 * Currently it holds mainThreadIndex to make things easier because most of the
 * places require a single thread index instead of thread indexes array.
 * This will go away soon.
 */
export type ActiveTabMainTrack = {|
  type: 'tab',
  threadIndexes: Set<ThreadIndex>,
  threadsKey: ThreadsKey,
|};

export type ActiveTabScreenshotTrack = {|
  +type: 'screenshots',
  +id: string,
  +threadIndex: ThreadIndex,
|};

export type ActiveTabResourceTrack =
  | {|
      +type: 'sub-frame',
      +threadIndex: ThreadIndex,
      +name: string,
    |}
  | {|
      +type: 'thread',
      +threadIndex: ThreadIndex,
      +name: string,
    |};

/**
 * Timeline for active tab view.
 * It holds main track for the current tab, screenshots and resource tracks.
 * Main track is being computed during profile load and rest is being added to resources.
 * This timeline type is different compared to full view. This makes making main
 * track acess a lot easier.
 */
export type ActiveTabTimeline = {
  mainTrack: ActiveTabMainTrack,
  screenshots: Array<ActiveTabScreenshotTrack>,
  resources: Array<ActiveTabResourceTrack>,
  resourcesThreadsKey: ThreadsKey,
};

export type ActiveTabGlobalTrack =
  | ActiveTabMainTrack
  | ActiveTabScreenshotTrack;

export type ActiveTabTrack = ActiveTabGlobalTrack | ActiveTabResourceTrack;

/**
 * Type that holds the values of personally identifiable information that user
 * wants to remove.
 */
export type RemoveProfileInformation = {|
  // Remove the given hidden threads if they are provided.
  +shouldRemoveThreads: Set<ThreadIndex>,
  // Remove the given counters if they are provided.
  +shouldRemoveCounters: Set<CounterIndex>,
  // Remove the screenshots if they are provided.
  +shouldRemoveThreadsWithScreenshots: Set<ThreadIndex>,
  // Remove the full time range if StartEndRange is provided.
  +shouldFilterToCommittedRange: StartEndRange | null,
  // Remove all the URLs if it's true.
  +shouldRemoveUrls: boolean,
  // Remove the extension list if it's true.
  +shouldRemoveExtensions: boolean,
  // Remove the preference values if it's true.
  +shouldRemovePreferenceValues: boolean,
  // Remove the private browsing data if it's true.
  +shouldRemovePrivateBrowsingData: boolean,
  // Remove all tab ids except this one.
  +shouldRemoveTabsExceptTabID: TabID | null,
|};

/**
 * This type is used to decide how to highlight and stripe areas in the
 * timeline.
 */
export type SelectedState =
  // Samples can be filtered through various operations, like searching, or
  // call tree transforms.
  | 'FILTERED_OUT_BY_TRANSFORM'
  // Samples can be filtered out if they are not part of the active tab.
  | 'FILTERED_OUT_BY_ACTIVE_TAB'
  // This sample is selected because either the tip or an ancestor call node matches
  // the currently selected call node.
  | 'SELECTED'
  // This call node is not selected, and the stacks are ordered before the selected
  // call node as sorted by the getTreeOrderComparator.
  | 'UNSELECTED_ORDERED_BEFORE_SELECTED'
  // This call node is not selected, and the stacks are ordered after the selected
  // call node as sorted by the getTreeOrderComparator.
  | 'UNSELECTED_ORDERED_AFTER_SELECTED';

/**
 * It holds the initially selected track's HTMLElement. This allows the timeline
 * to scroll the initially selected track into view once the page is loaded.
 */
export type InitialSelectedTrackReference = HTMLElement;

/**
 * Page data for ProfileFilterNavigator component.
 */
export type ProfileFilterPageData = {|
  origin: string,
  hostname: string,
  favicon: string,
|};

/**
 * Information about the Tab selector state that is sorted by their tab activity
 * scores.
 */
export type SortedTabPageData = Array<{|
  tabID: TabID,
  tabScore: number,
  pageData: ProfileFilterPageData,
|}>;

export type CallNodeLeafAndSummary = {|
  // This property stores the amount of unit (time, bytes, count, etc.) spent in the
  // stacks' leaf nodes.
  callNodeLeaf: Float32Array,
  // The sum of absolute values in callNodeLeaf.
  // This is used for computing the percentages displayed in the call tree.
  rootTotalSummary: number,
|};

/**
 * The self and total time, usually for a single call node.
 * As with most places where the terms "self" and "total" are used, the meaning
 * of the numbers depends on the context:
 *  - When used for "traced" timing, the values are Milliseconds.
 *  - Otherwise, the values are in the same unit as the sample weight type. For
 *    example, they could be sample counts, weights, or bytes.
 */
export type SelfAndTotal = {| self: number, total: number |};

/*
 * Event delay table that holds the pre-processed event delay values and other
 * statistics about it.
 * Gecko sends the non processed event delay values to the front-end and we have
 * to make a calculation to find out their real values. Also see:
 * https://searchfox.org/mozilla-central/rev/3811b11b5773c1dccfe8228bfc7143b10a9a2a99/tools/profiler/core/platform.cpp#3000-3186
 */
export type EventDelayInfo = {|
  +eventDelays: Float32Array,
  +minDelay: Milliseconds,
  +maxDelay: Milliseconds,
  +delayRange: Milliseconds,
|};

/**
 * This is a unique key that can be used in an object cache that represents either
 * a single thread, or a selection of multiple threads. When it's a number, it's
 * the ThreadIndex. When there are multiple threads, the key is a string of sorted,
 * comma separated thread indexes, e.g. "5,7,10"
 */
export type ThreadsKey = string | number;

/**
 * A representation of a native symbol which is independent from a thread.
 * This is used for storing the global state of the assembly view, which needs
 * to be independent from the selected thread. An IndexIntoNativeSymbolTable
 * would only be meaningful within a thread.
 * This can be removed if the native symbol table ever becomes global.
 */
export type NativeSymbolInfo = {|
  name: string,
  address: Address,
  // The number of bytes belonging to this function, starting at the symbol address.
  // If functionSizeIsKnown is false, then this is a minimum size.
  functionSize: Bytes,
  functionSizeIsKnown: boolean,
  libIndex: IndexIntoLibs,
|};

/**
 * Information about the initiating call node when the bottom box (source view +
 * assembly view) is updated.
 */
export type BottomBoxInfo = {|
  libIndex: IndexIntoLibs | null,
  sourceFile: string | null,
  nativeSymbols: NativeSymbolInfo[],
|};

/**
 * Favicon data that is retrieved from the browser connection.
 */
export type FaviconData = {|
  +data: ArrayBuffer,
  +mimeType: string,
|};
