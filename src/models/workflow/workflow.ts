export interface Workflow {
    id: string;
    name: string;
    description: string;
    enabled: number;
    channel: string;
    page_id: string;
    page_ids: string;
    nodes_json: string;
    edges_json: string;
    created_at: number;
    updated_at: number;
}

export interface WorkflowRunLog {
    id: string;
    workflow_id: string;
    workflow_name: string;
    triggered_by: string;
    started_at: number;
    finished_at: number;
    status: string;
    error_message?: string;
    node_results: string;
}
