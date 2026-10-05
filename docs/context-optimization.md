# Context optimization policy

Factory workflows provide an agent with:

1. the issue and acceptance criteria;
2. project instructions;
3. limited relevant Hindsight recall;
4. agent-native repository discovery;
5. references to validation artifacts.

They do not proactively inject an entire repository, unrelated architecture
documents, complete issue history, full transcripts, or verbose test logs.
Review starts with the Git diff. Failure summaries lead with exact failure
sections and link to the complete artifact so an agent can retrieve more only
when needed.
