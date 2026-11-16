import type {
  ObjectJsonSchema,
  ObjectValueSchemaSpec,
  ParameterJsonSchema,
  ParameterSchemaSpec,
  ToolOutputDefinition,
} from '@deepseek-ai/dsh-tools'

/** Fields read by CCG tools; the executor may supply the complete SDK context. */
export interface InvocationContext {
  agent?: { id?: string; session?: { header?: { cwd?: string } } }
  signal?: AbortSignal
}

interface ToolDeclaration {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: {
    schema: ObjectValueSchemaSpec
    render(args: never, value: never): Array<{ type: 'text'; text: string }>
    presentationMeta?: ToolOutputDefinition['presentationMeta']
  }
  execute(args: never, exec: InvocationContext): Promise<unknown>
}

/** The compiler replaces the authoring schemas and forwards the local callbacks. */
export type ToolCompiler = <T extends ToolDeclaration>(
  definition: T
) => Omit<T, 'parameters' | 'output'> & {
  parameters: ParameterJsonSchema
  output: Omit<T['output'], 'schema'> & { schema: ObjectJsonSchema }
}
