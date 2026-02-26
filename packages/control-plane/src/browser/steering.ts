/**
 * Annotation Steering
 *
 * Converts UI annotations (clicks, typing, scrolling, etc.) from the
 * dashboard overlay into structured SteerActions that the agent can
 * execute against the browser context.
 */

import type { AnnotationPayload, SteerAction } from "@cortex/shared/browser"

/**
 * Convert a dashboard annotation into a structured action for the agent.
 */
export function annotationToAction(annotation: AnnotationPayload): SteerAction {
  switch (annotation.type) {
    case "click":
      return {
        actionType: "click",
        target: annotation.selector ?? `coordinates(${annotation.coordinates.x},${annotation.coordinates.y})`,
        parameters: {
          x: annotation.coordinates.x,
          y: annotation.coordinates.y,
          selector: annotation.selector,
          ...annotation.metadata,
        },
      }

    case "type":
      return {
        actionType: "fill",
        target: annotation.selector ?? `coordinates(${annotation.coordinates.x},${annotation.coordinates.y})`,
        parameters: {
          x: annotation.coordinates.x,
          y: annotation.coordinates.y,
          text: annotation.text ?? "",
          selector: annotation.selector,
          ...annotation.metadata,
        },
      }

    case "scroll":
      return {
        actionType: "scroll",
        target: annotation.selector ?? "viewport",
        parameters: {
          x: annotation.coordinates.x,
          y: annotation.coordinates.y,
          direction: (annotation.metadata.direction as string) ?? "down",
          amount: (annotation.metadata.amount as number) ?? 300,
          ...annotation.metadata,
        },
      }

    case "highlight":
      return {
        actionType: "highlight",
        target: annotation.selector ?? `coordinates(${annotation.coordinates.x},${annotation.coordinates.y})`,
        parameters: {
          x: annotation.coordinates.x,
          y: annotation.coordinates.y,
          selector: annotation.selector,
          text: annotation.text,
          ...annotation.metadata,
        },
      }

    case "select":
      return {
        actionType: "select",
        target: annotation.selector ?? `coordinates(${annotation.coordinates.x},${annotation.coordinates.y})`,
        parameters: {
          x: annotation.coordinates.x,
          y: annotation.coordinates.y,
          selector: annotation.selector,
          value: annotation.text,
          ...annotation.metadata,
        },
      }
  }
}

/**
 * Build a human-readable steering prompt from an annotation,
 * suitable for injection into the agent message stream.
 */
export function annotationToPrompt(annotation: AnnotationPayload): string {
  const { type, coordinates, selector, text } = annotation
  const loc = selector
    ? `element "${selector}" at (${coordinates.x}, ${coordinates.y})`
    : `coordinates (${coordinates.x}, ${coordinates.y})`

  switch (type) {
    case "click":
      return `User clicked on ${loc}. Investigate and interact with this element.`
    case "type":
      return `User wants to type "${text ?? ""}" into ${loc}. Fill this input field.`
    case "scroll":
      return `User scrolled ${(annotation.metadata.direction as string) ?? "down"} at ${loc}.`
    case "highlight":
      return `User highlighted ${loc}${text ? `: "${text}"` : ""}. Focus on this element.`
    case "select":
      return `User selected "${text ?? ""}" in ${loc}. Apply this selection.`
  }
}
