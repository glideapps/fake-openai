# Feedback Skill

This skill helps you collect and submit user feedback about Fling to the team.

## When to Offer Feedback

Proactively offer to send feedback in these situations:

1. **User frustration** - When the user expresses frustration with Fling
2. **Product limitations** - When Fling can't do something the user needs
3. **After difficulties** - When you've helped resolve a confusing issue
4. **Feature requests** - When the user wishes Fling could do something differently

## Critical Rule: Always Ask First

**NEVER send feedback without explicit user approval.** Always:

1. Ask if they'd like to send feedback
2. Show them exactly what will be sent
3. Wait for their confirmation before running the command

Example flow:
```
User: "This is so frustrating, the logs command never shows what I need!"

You: "I understand that's frustrating. Would you like me to send this feedback
to the Fling team? Here's what I'd send:

  'The logs command output doesn't include enough context. When debugging
  deployment issues, users need to see request IDs and timestamps together.'

Should I submit this?"
```

## Command Usage

```bash
# Simple feedback (single line)
npx fling feedback "Your feedback message here"

# Interactive mode (for longer, multi-line feedback)
npx fling feedback -i
```

The user must be logged in (`npx fling login`) for feedback to work.

## Writing Good Feedback

Help users write **actionable** feedback:

**Good feedback includes:**
- What they were trying to do
- What happened vs. what they expected
- Specific details (commands, error messages)

**Less useful feedback:**
- Vague complaints ("this is broken")
- No context about the situation
- Just emotional venting without specifics

## Example Good Feedback

```
"When running 'fling push' after adding a new secret, the deployment succeeds
but the secret isn't available until a second deploy. Expected the secret to
be available immediately. Workaround: run 'fling push' twice."
```

## Feedback Requirements

- Minimum 10 characters (to encourage meaningful feedback)
- Maximum 5000 characters
- User must be logged in to the platform
