// a minimal, complete starting point for "+ New custom addon" on
// Addons.tsx - pick a note, type a sat amount to peel off, tag and split
// it. Small enough to read in full, big enough to show the shape of a
// manifest's state/ui/permissions/note.split call together, including the
// satsToMsat global helper every custom addon needs for this (the
// expression grammar itself has no arithmetic - see globalHelpers.ts).
// Kept in its own plain module (not inline in Addons.tsx) so it can be
// unit-tested without pulling a Solid Router-using page component into the
// Node-only test environment (vitest.config.ts's `environment: 'node'`).
export const STARTER_TEMPLATE = `{
  "id": "my-addon",
  "name": "My Addon",
  "version": "1",
  "icon": "pricetags",
  "description": "Splits a chosen sat amount off a note.",
  "permissions": [
    {"verb": "note.split", "reason": "Split the chosen amount off the note"}
  ],
  "state": {
    "sourceNote": null,
    "amountSat": 1000,
    "results": []
  },
  "ui": {
    "type": "View",
    "children": [
      {"type": "Text", "value": "My Addon", "style": "heading"},
      {
        "type": "NotePicker",
        "bind": "sourceNote",
        "filter": {"spent": false},
        "label": "Note to split"
      },
      {"type": "Input", "bind": "amountSat", "kind": "number", "label": "Sats to split off"},
      {
        "type": "Show",
        "when": {
          "and": [
            {"var": "sourceNote"},
            {"gt": [{"var": "amountSat"}, 0]},
            {"gt": [{"var": "sourceNote.amountSat"}, {"var": "amountSat"}]}
          ]
        },
        "children": [
          {
            "type": "Button",
            "label": "Split",
            "onClick": {
              "verb": "note.split",
              "args": {
                "note": {"var": "sourceNote.id"},
                "tickets": [
                  {
                    "amountMsat": {"helper": "satsToMsat", "args": [{"var": "amountSat"}]},
                    "tags": ["my-addon"]
                  }
                ]
              },
              "result": "results"
            }
          }
        ]
      },
      {
        "type": "For",
        "each": {"var": "results"},
        "children": [
          {
            "type": "View",
            "style": "ticket",
            "children": [{"type": "QrDisplay", "value": {"var": "item.url"}}]
          }
        ]
      }
    ]
  }
}`
