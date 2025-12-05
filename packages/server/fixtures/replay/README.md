# Recorded generation traces

Each file holds one generation captured from a live run: the description, the
full trace of tool calls, and the model that came out. In replay mode the
server answers from these and cannot reach a provider at all.

Record one with:

    npm run record --workspace=@nlam/server -- "a book tracker with a genre filter"
