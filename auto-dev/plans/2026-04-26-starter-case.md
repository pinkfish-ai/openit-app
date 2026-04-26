# first e2e case: agent responds to tickets, learning from each ticket

## setup
- User downloads the app
- User creates account on PF and authenticates (we need to make auth more smooth) - right now needs to get api tokens. 
- User auth's to slack or teams (optional)
- User clicks continue to main app

## welcome 
- welcome has popup for user to test sending first ticket (or can send from slack/teams) has a canned first ticket: how do i reset my password. 
- user sends ticket, hits remote agent, agent looks for workflow or KB answer and finds none. says will escalate to human.
- ticket is added to database
- user is added to people table
- app surfaces escalated ticket with banner to resolve or automate in claude code.
- automate has 2 options: KB or Workflow
- walk through creating an answer in the KB
- ask question again and get answer from KB
