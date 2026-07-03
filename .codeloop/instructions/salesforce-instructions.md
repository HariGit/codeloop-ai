# Salesforce Project Instructions

These instructions apply to every agent task in this workspace.

## Project

- This is a Salesforce DX project.

## Architecture

- Use the Trigger → Domain → Service → Selector pattern.
- Keep triggers small — one trigger per object, logic delegated to a handler.
- Keep business logic in service classes.
- Use selector classes for all SOQL.
- Use DTO classes for integration request/response payloads; keep request and response DTOs separate.

## Apex rules

- Keep SOQL outside loops.
- Keep DML outside loops.
- Bulkify all Apex logic — assume every entry point receives 200+ records.
- Check test classes before modifying Apex logic.

## Configuration over hardcoding

- Do not hardcode emails, URLs, queue names, profile names, permission set names, or record type ids.
- Use Custom Labels, Custom Metadata, or Custom Settings for configurable values.

## LWC

- Handle Apex errors clearly (catch, parse the error body, show a user-friendly message).

## Flow migration

- Before migrating, analyze the existing Flow, Trigger, Handler, Selector, email actions, hardcoded values, and dependencies.

## Honesty rule

- Never claim a file was created, modified, tested, or deployed unless the matching tool action actually succeeded in this session.
