## Key beats

1. Claude Code is the OS — configure in plain English, not clicky admin UIs.
2. Employees ask where they already work — Slack/Teams, no new app.
3. One conversation across every system — and Claude writes the integration if it's missing.
4. It learns from how you work — answer once, Claude handles the next one and leaves a KB article behind.
5. Skills and scripts are the unit of work — Claude generates either on demand, and runs scripts two ways: when the IT admin asks, or automatically as part of a learned workflow. Provisioning, offboarding, reports, investigations all live as files you can read and edit.
6. Local first, then cloud — your repo is the source of truth; no lock-in.

---

OpenIT is the first IT Helpdesk, and maybe the first application ever, that runs on Claude Code.

Its an open source downloadable application that your IT admin runs on their laptop.

Employees ask where they already work: Slack and Teams

When employees ask for help on Slack or Teams, the questions flow into OpenIT where Claude triages and attempts to answer. If Claude hasn't seen the question before, it's escalated to the IT Admin.

It learns from how you work: 
After the IT admin answers once, Claude captures the answer _and the workflow_ so that it can automate the response the next time.

Here's an example where an employee asks the most common suport question ever: I can't login.

Since we're on a brand new instance of OpenIT, Claude hasn't seen the question before, and so it's escalated to a human.

The human answers the question: 
To reset your password, visit this link [link] and request a password reset.

After answering, Claude captures the answer and converts it into a new knowledge base article.

And so the next time someone asks this kind of question, it'll return the knowledge base article.[show another one]

But we've just scratched the surface. As you can see, we've got Claude Code integrated right into the app.

So any and all IT functionality is at your fingertips. 

Like: 
* Running a workflow to provision a new user - that's just a claude Skill 
* Investigating an error on your GCP app - that's running a query to Cloudlogs with the GCP CLI. 
* Creating a custom report based on your ticket data - that's a conversation with Claude 
* Running a complex offboarding sequence, that's a Skill with a script.

And if we haven't bundled it into OpenIT already, it's Open! So you can ask Claude to build you a new skill or a new script to your spec.

There's no lock in. All the skills and scripts are right there in the file system for you to see and edit.

We offer a sync-to-cloud option - so you can run OpenIT in the cloud when you're ready to move it off your desktop.

With Claude Code as the Operating Sytem - there's an incredible vareity of work you can do - so if you're on one of those systems that costs $29 or $29,000 a month, I'm betting you can do most of what that system does with Claude Code and OpenIT.
