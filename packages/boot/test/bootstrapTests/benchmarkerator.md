# The Benchmarkerator

*The Benchmarkerator* is a tool for creating and running chain benchmarks.  It
is loosely inspired by Ava.  Of course, since its purpose is performance testing
rather than correctness testing, it does differ from Ava quite a bit.  Two big
differences you may notice immediately are that it's much, much simpler and that
benchmark modules are standalone Node executables rather than things to be
driven by an external orchestrator program.

Note that the current version of The Benchmarkerator is specifically designed
for performance testing things that run on chain[^1], i.e., vats and contracts.
A lot of what it does is manage the configuration and setup for a swingset with
all the various chain components up and running.  While it should be easy for us
to adapt it to also support benchmarking things that run in vats more generally
without the rest of the chain-specific infrastructure, that is for the future
and only if there is demand for it.  We are not currently planning to adapt it
for non-swingset benchmarking, though it is possible that a similar tool may be
concocted for that purpose should it seem warranted.

[^1]: The term "chain" is slightly confusing here, but will have to do until the
    product folks give us better terminology.  There is no actual chain per se,
    merely a swingset containing the various vats and contracts that make up the
    default Agoric ecosystem, along with an ersatz bridge device that can be
    used to inject message traffic as if it had originated from actual Cosmos
    messages.

## Writing a benchmark

By convention a benchmark should be placed in source file a named
`benchmark-yourbenchmarkname.js` (substitute your own benchmark name of course),
which, by convention, goes in the `benchmarks` directory of your package,
parallel to the conventional `test` directory (as of this writing very few
packages have such a `benchmarks` directory, so you might need to add it
yourself).[^2]

[^2]: In the fullness of time, the `yarn bench` command will be updated to run
    all the benchmarks found in the `benchmarks` directory, much as it now runs
    the older, Ava-based benchmarks that it looks for in the `test` directory.
    Those will themselves be deprecated and/or moved into `benchmarks`.
    However, as of this writing that has not yet been done.

The first thing a benchmark should do is import The Benchmarkerator:[^3]
```
import { bench } from '@agoric/benchmark';
```

[^3]: As of this writing The Benchmarkerator actually lives in
    `@agoric/boot/test/boostrapTests/benchmarkerator.js`.  This should be
    changed soon, hopefully before the first PR containing this writeup is
    landed, in which case you will never see this footnote.

Note that this importation usually should be the very first thing you do, much
as you typically import `@agoric/swingset-vat/tools/prepare-test-env-ava.js` or
`@agoric/zoe/tools/prepare-test-env-ava.js` or the like as the first thing in a
test implementation.  The exception, as with tests, is imports that bring in any
kind of pre-lockdown functionality that you will be needing to use; however,
that should be necessary only in very specialized circumstances.

In a manner similar to the way tests are packaged for Ava, a benchmark file can
actually contain multiple benchmark tests.  Each should be declared with a
statement of the form:

`bench.addBenchmark(label: string, benchmark: Benchmark);`

where `label` is a string labelling the benchmark (much as individual tests are
labelled in Ava), and `benchmark` is an object describing the benchmark itself
(which will be described in detail below)

After defining one or more benchmarks with `addBenchmark` you must then end by
invoking:

```await bench.run(name);```

where `name` is a string naming the benchmark run for purposes of error and
result reporting.

#### The `Benchmark` object

The `benchmark` object may have the following properties, all of which are
optional except for `executeRound`:

`setup?: (context: BenchmarkContext) => Promise<Record<string, unknown> | undefined>`

  An optional async method to perform any pre-run setup that you need to do. It
  may optionally return a configuration record containing any benchmark-specific
  information you desire.  This will be provided as part of the context object
  in subsequent calls into the benchmark.

`executeRound: (context: BenchmarkContext, round: number) => Promise<void>`

  A required async method which is called to actually execute one round of the
  benchmark.  The `round` argument is the number of the benchmark round
  that this call to `executeRound` is being asked to execute.

`finish?: (context: BenchmarkContext) => Promise<void>`

  An optional async method to perform any post-run teardown that you need to do.

`rounds?: number`

  The number of benchmark rounds that will be run if not overridden on the
  command line.  If omitted, it defaults to `1`.

#### The `BenchmarkContext` object

The first parameter to each of the benchmark methods is a context object that
provides various information about the execution.  It has the properties:

`options: Record<string, string>`

  Named options from the command line (see Command Line below).

`argv: string[]`

  Remaining unparsed arguments from the command line.

`actors: Record<string, SmartWalletDriver>`

  Wallet drivers for the various personae that exist in the test environment.
  Currently present are `gov1`, `gov2`, and `gov3` (the governance committee);
  `atom1` and `atom2` (ersatz ATOM-USD price feed oracles); and `alice`, `bob`,
  and `carol` (arbitrary users to participate in interactions being exercised).

`label: string`

  The benchmark label, from the `addBenchmark` call that defined this benchmark.

`rounds: number`

  The total number of benchmark rounds that are to be executed in this run.

`config?: Record<string, unknown>`

  The configuration object that was returned by the `setup` method, if one was.

## Executing a benchmark

The benchmark that you define by incorporating The Benchmarkerator is a
standalone Node executable.  You run it with the command:

`node benchmark-yourbenchmarkname.js [OPTIONS...]`

The supported command line options are:

| Option | What |
|--------|------|
| `-r N`<br/>`--rounds N` | Execute _N_ rounds of each benchmark |
| `-b PATT`<br/>`--benchmark PATT` | Only execute benchmarks matching _PATT_ (may be specified more than once; this is similar to Ava's `-m` option)|
| `-o NAME VAL`<br/>`--option NAME VAL` | Set option _NAME_ to _VAL_ in the `context.options` record (may be specified more than once)  |
| `-v`<br/>`--verbose` | Output verbose debug log messages as it runs |
| `-l`<br/>`--local` | Use the `'local'` vat manager (instead of `'xs-worker'`; yields less realistic perf numbers but runs way faster and is much easier to debug) |
| `-d`<br/>`--dump` | Output JSON-formated benchmark data to a file |
| `-h`<br/>`--help` | Output this helpful usage information and then exit |

additional unparsed _OPTIONS_ are passed to the benchmark itself in the `context.argv`
array.

## Results output

Timing results and other collected metrics are output to _stdout_.  Two batches
of information are provided: one for the setup phase and one for the benchmark
rounds themselves (in aggregate).

In addition, if you specify the `--dump` command line option, a JSON-formatted
(i.e., machine readable) version of this same data will be output to the file
`benchmark-NAME.json` in the current working directory (where _NAME_ is the name
that you provided as the argument to `bench.run`).

Output results include execution times (according to Node's nanosecond clock),
crank counts, and the various kernel resource usage data reported by
`controller.getStats()`.
