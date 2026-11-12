export { default as process } from "node:process";

export class DefaultJsonSchemaValidator {
  getValidator() {
    throw new Error("Sage does not support JSON Schema elicitation validation.");
  }
}
