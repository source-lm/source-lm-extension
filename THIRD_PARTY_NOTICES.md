# Third-party notices

Source LM ships no runtime dependencies. The notice below covers work this
project was derived from rather than code it bundles.

## gemini-notebook-mcp-cli (formerly notebooklm-mcp-cli)

The private `batchexecute` protocol used in `src/content/rpc.ts` and
`src/content/notebook.ts` was reverse-engineered in that project; the
transport logic here is a TypeScript re-implementation of what it documented
in Python. Included under the terms of its licence:

```
MIT License

Copyright (c) 2025 Jacob Ben David

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The MIT licence permits sublicensing, so Source LM as a whole is distributed
under [PolyForm Noncommercial 1.0.0](./LICENSE.md); that choice does not
apply retroactively to the work above, which remains available under MIT from
its own authors.
