---
name: OpenIT
description: IT operations and service management plugin for Claude Code. Manage tickets, provision employees, query systems, and automate workflows.
---

# OpenIT Plugin for Claude Code

OpenIT is an AI-powered IT service management platform. This plugin enables Claude to help with IT operations tasks within your OpenIT workspace.

## What You Can Do

- **Create and manage tickets** - File, query, and resolve IT service tickets
- **Onboard/offboard employees** - Automate provisioning and revocation across connected systems
- **Query databases** - Search employee records, asset inventory, and ticket history
- **Run workflows** - Execute automated processes triggered by events
- **Create agents** - Build AI agents that handle specific IT workflows
- **Manage knowledge** - Upload and search documentation, runbooks, and procedures

## Project Structure

```
your-project/
├── agents/                    # AI agents for specific IT workflows
├── workflows/                 # Automated processes and integrations
├── databases/                 # Structured data (tickets, employees, assets, etc.)
├── knowledge-base/            # Documentation and runbooks
├── filestore/                 # File storage for the workspace
├── .claude/
│   └── skills/                # Claude Code skills for IT operations
├── _welcome.md                # Project overview
└── .gitignore
```

## Available Skills

The OpenIT plugin includes the following Claude Code skills to help with common IT tasks:

### Core Skills
- **get-started** - Welcome and onboarding to your OpenIT workspace
- **query-database** - Search and retrieve data from your databases
- **create-agent** - Create new AI agents for your workflows
- **run-workflow** - Execute your existing workflows
- **knowledge-base** - Search and upload documentation
- **deploy** - Deploy and manage your workspace

### Advanced Skills
- **onboard-employee** - Day-1 provisioning across all connected systems
- **offboard-employee** - Revocation cascade with audit trail
- **create-skill** - Create new Claude Code skills for your team

## Getting Started

1. **Open your project in Claude Code** - Clone or open your OpenIT workspace folder
2. **Use the skill bubbles** - Quick buttons at the bottom for common tasks
3. **Ask Claude directly** - Describe what you need (e.g., "Create a ticket for a new laptop request")
4. **Explore the databases** - Click on database records to work with real data

## Key Integrations

OpenIT connects to:
- **Okta / Azure AD** - User provisioning and authentication
- **Google Workspace / Microsoft 365** - Email and collaboration
- **Slack / Microsoft Teams** - Notifications and integration
- **Jira / ServiceNow** - Ticketing systems
- **Custom APIs** - Any system with an OAuth connection

## Tips

- Drag records from the File Explorer into chat to reference them
- Use the `/create-agent` skill to build custom workflows
- Check the _welcome.md file for a detailed project overview
- All your work is automatically version-controlled with Git
