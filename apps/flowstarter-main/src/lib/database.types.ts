export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      ai_audit_logs: {
        Row: {
          action: string | null
          agent: string | null
          created_at: string
          encrypted_payload: string
          id: string
          ip: unknown
          pipeline_id: string | null
          route: string | null
          user_agent: string | null
          user_id: string
          username: string | null
          workspace_id: string | null
        }
        Insert: {
          action?: string | null
          agent?: string | null
          created_at?: string
          encrypted_payload: string
          id?: string
          ip?: unknown
          pipeline_id?: string | null
          route?: string | null
          user_agent?: string | null
          user_id: string
          username?: string | null
          workspace_id?: string | null
        }
        Update: {
          action?: string | null
          agent?: string | null
          created_at?: string
          encrypted_payload?: string
          id?: string
          ip?: unknown
          pipeline_id?: string | null
          route?: string | null
          user_agent?: string | null
          user_id?: string
          username?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_audit_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_rights_confirmations: {
        Row: {
          asset_ids: string[]
          confirmed_at: string
          confirmed_by: string
          created_at: string
          id: string
          ip: string | null
          statement_version: string | null
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          asset_ids?: string[]
          confirmed_at?: string
          confirmed_by: string
          created_at?: string
          id?: string
          ip?: string | null
          statement_version?: string | null
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          asset_ids?: string[]
          confirmed_at?: string
          confirmed_by?: string
          created_at?: string
          id?: string
          ip?: string | null
          statement_version?: string | null
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_rights_confirmations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          ai_generated: boolean
          aspect_ratio: number | null
          caption: string | null
          created_at: string
          dominant_colors: string[] | null
          has_transparency: boolean | null
          height: number | null
          id: string
          is_placeholder: boolean
          kind: string | null
          mime: string | null
          project_id: string | null
          rights_confirmed_at: string | null
          selected: boolean
          sha256: string | null
          sharpness_score: number | null
          source: string
          source_url: string | null
          storage_path: string | null
          usable_for: string[]
          width: number | null
          workspace_id: string
        }
        Insert: {
          ai_generated?: boolean
          aspect_ratio?: number | null
          caption?: string | null
          created_at?: string
          dominant_colors?: string[] | null
          has_transparency?: boolean | null
          height?: number | null
          id?: string
          is_placeholder?: boolean
          kind?: string | null
          mime?: string | null
          project_id?: string | null
          rights_confirmed_at?: string | null
          selected?: boolean
          sha256?: string | null
          sharpness_score?: number | null
          source: string
          source_url?: string | null
          storage_path?: string | null
          usable_for?: string[]
          width?: number | null
          workspace_id: string
        }
        Update: {
          ai_generated?: boolean
          aspect_ratio?: number | null
          caption?: string | null
          created_at?: string
          dominant_colors?: string[] | null
          has_transparency?: boolean | null
          height?: number | null
          id?: string
          is_placeholder?: boolean
          kind?: string | null
          mime?: string | null
          project_id?: string | null
          rights_confirmed_at?: string | null
          selected?: boolean
          sha256?: string | null
          sharpness_score?: number | null
          source?: string
          source_url?: string | null
          storage_path?: string | null
          usable_for?: string[]
          width?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_signals: {
        Row: {
          created_at: string
          derived_at: string
          id: string
          keywords: string[]
          palette: Json
          sources: string[]
          tone_notes: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          derived_at?: string
          id?: string
          keywords?: string[]
          palette?: Json
          sources?: string[]
          tone_notes?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          derived_at?: string
          id?: string
          keywords?: string[]
          palette?: Json
          sources?: string[]
          tone_notes?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brand_signals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      client_constraint_profiles: {
        Row: {
          allowed_operations: Json
          created_at: string
          id: string
          is_default: boolean
          name: string
          system_prompt: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          allowed_operations?: Json
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          system_prompt: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          allowed_operations?: Json
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          system_prompt?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_constraint_profiles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      commerce_products: {
        Row: {
          checkout_url: string | null
          created_at: string
          currency: string
          delivery_url: string | null
          fulfillment_type: string | null
          id: string
          inventory_policy: string
          inventory_quantity: number | null
          metadata: Json
          name: string
          price_amount: number | null
          product_type: string
          provider_price_id: string | null
          provider_product_id: string | null
          short_description: string | null
          slug: string | null
          status: string
          updated_at: string
          weight_grams: number | null
          workspace_id: string
        }
        Insert: {
          checkout_url?: string | null
          created_at?: string
          currency?: string
          delivery_url?: string | null
          fulfillment_type?: string | null
          id?: string
          inventory_policy?: string
          inventory_quantity?: number | null
          metadata?: Json
          name: string
          price_amount?: number | null
          product_type?: string
          provider_price_id?: string | null
          provider_product_id?: string | null
          short_description?: string | null
          slug?: string | null
          status?: string
          updated_at?: string
          weight_grams?: number | null
          workspace_id: string
        }
        Update: {
          checkout_url?: string | null
          created_at?: string
          currency?: string
          delivery_url?: string | null
          fulfillment_type?: string | null
          id?: string
          inventory_policy?: string
          inventory_quantity?: number | null
          metadata?: Json
          name?: string
          price_amount?: number | null
          product_type?: string
          provider_price_id?: string | null
          provider_product_id?: string | null
          short_description?: string | null
          slug?: string | null
          status?: string
          updated_at?: string
          weight_grams?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commerce_products_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_submissions: {
        Row: {
          created_at: string | null
          email: string
          id: string
          message: string
          name: string
          notes: string | null
          read_at: string | null
          responded_at: string | null
          subject: string
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          message: string
          name: string
          notes?: string | null
          read_at?: string | null
          responded_at?: string | null
          subject: string
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          message?: string
          name?: string
          notes?: string | null
          read_at?: string | null
          responded_at?: string | null
          subject?: string
        }
        Relationships: []
      }
      custom_inquiries: {
        Row: {
          admin_notes: string | null
          booking_link: string | null
          budget_range: string
          company_name: string
          created_at: string
          email: string
          id: string
          industry: string
          justification: string
          name: string
          project_type_other: string | null
          project_types: string[]
          referral_source: string | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          role: string
          status: string
          timeline: string
          updated_at: string
          website: string | null
        }
        Insert: {
          admin_notes?: string | null
          booking_link?: string | null
          budget_range: string
          company_name: string
          created_at?: string
          email: string
          id?: string
          industry: string
          justification: string
          name: string
          project_type_other?: string | null
          project_types?: string[]
          referral_source?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role: string
          status?: string
          timeline: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          admin_notes?: string | null
          booking_link?: string | null
          budget_range?: string
          company_name?: string
          created_at?: string
          email?: string
          id?: string
          industry?: string
          justification?: string
          name?: string
          project_type_other?: string | null
          project_types?: string[]
          referral_source?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role?: string
          status?: string
          timeline?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      demo_edit_counters: {
        Row: {
          created_at: string
          demo_id: string
          edits_used: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          demo_id?: string
          edits_used?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          demo_id?: string
          edits_used?: number
          updated_at?: string
        }
        Relationships: []
      }
      demo_generation_costs: {
        Row: {
          cost_eur: number
          created_at: string
          demo_id: string | null
          id: string
          ip: string | null
          kind: string
          lead_email: string | null
          model: string | null
          tokens_in: number
          tokens_out: number
        }
        Insert: {
          cost_eur?: number
          created_at?: string
          demo_id?: string | null
          id?: string
          ip?: string | null
          kind: string
          lead_email?: string | null
          model?: string | null
          tokens_in?: number
          tokens_out?: number
        }
        Update: {
          cost_eur?: number
          created_at?: string
          demo_id?: string | null
          id?: string
          ip?: string | null
          kind?: string
          lead_email?: string | null
          model?: string | null
          tokens_in?: number
          tokens_out?: number
        }
        Relationships: []
      }
      deployments: {
        Row: {
          artifact_bytes: number | null
          artifact_sha256: string | null
          artifact_url: string | null
          deployed_by: string | null
          finished_at: string | null
          id: string
          metadata: Json
          rolled_back_from_id: string | null
          started_at: string
          status: string
          status_detail: string | null
          version: number
          workspace_id: string
        }
        Insert: {
          artifact_bytes?: number | null
          artifact_sha256?: string | null
          artifact_url?: string | null
          deployed_by?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json
          rolled_back_from_id?: string | null
          started_at?: string
          status?: string
          status_detail?: string | null
          version: number
          workspace_id: string
        }
        Update: {
          artifact_bytes?: number | null
          artifact_sha256?: string | null
          artifact_url?: string | null
          deployed_by?: string | null
          finished_at?: string | null
          id?: string
          metadata?: Json
          rolled_back_from_id?: string | null
          started_at?: string
          status?: string
          status_detail?: string | null
          version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deployments_rolled_back_from_id_fkey"
            columns: ["rolled_back_from_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      discovery_leads: {
        Row: {
          billing_cadence: string
          brand_tone: string | null
          business_name: string | null
          catalog_size: string | null
          commerce_mode: string | null
          created_at: string
          custom_integrations: string | null
          demo_id: string | null
          deposit_amount_eur: number | null
          deposit_paid_at: string | null
          deposit_status: string
          description: string
          email: string
          full_name: string
          goal: string | null
          id: string
          industry: string | null
          instagram_url: string | null
          linkedin_url: string | null
          page_count: string | null
          project_id: string | null
          secondary_goals: string[] | null
          selected_tier: string
          source: string | null
          stripe_session_id: string | null
          subscription: string | null
          target_audience: string | null
          timeline: string | null
          updated_at: string
        }
        Insert: {
          billing_cadence?: string
          brand_tone?: string | null
          business_name?: string | null
          catalog_size?: string | null
          commerce_mode?: string | null
          created_at?: string
          custom_integrations?: string | null
          demo_id?: string | null
          deposit_amount_eur?: number | null
          deposit_paid_at?: string | null
          deposit_status?: string
          description: string
          email: string
          full_name: string
          goal?: string | null
          id?: string
          industry?: string | null
          instagram_url?: string | null
          linkedin_url?: string | null
          page_count?: string | null
          project_id?: string | null
          secondary_goals?: string[] | null
          selected_tier: string
          source?: string | null
          stripe_session_id?: string | null
          subscription?: string | null
          target_audience?: string | null
          timeline?: string | null
          updated_at?: string
        }
        Update: {
          billing_cadence?: string
          brand_tone?: string | null
          business_name?: string | null
          catalog_size?: string | null
          commerce_mode?: string | null
          created_at?: string
          custom_integrations?: string | null
          demo_id?: string | null
          deposit_amount_eur?: number | null
          deposit_paid_at?: string | null
          deposit_status?: string
          description?: string
          email?: string
          full_name?: string
          goal?: string | null
          id?: string
          industry?: string | null
          instagram_url?: string | null
          linkedin_url?: string | null
          page_count?: string | null
          project_id?: string | null
          secondary_goals?: string[] | null
          selected_tier?: string
          source?: string | null
          stripe_session_id?: string | null
          subscription?: string | null
          target_audience?: string | null
          timeline?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discovery_leads_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      editor_sessions: {
        Row: {
          ended_at: string | null
          ended_reason: string | null
          id: string
          metadata: Json
          request_count: number
          started_at: string
          tokens_in: number
          tokens_out: number
          user_id: string
          user_role: string
          workspace_id: string
        }
        Insert: {
          ended_at?: string | null
          ended_reason?: string | null
          id?: string
          metadata?: Json
          request_count?: number
          started_at?: string
          tokens_in?: number
          tokens_out?: number
          user_id: string
          user_role: string
          workspace_id: string
        }
        Update: {
          ended_at?: string | null
          ended_reason?: string | null
          id?: string
          metadata?: Json
          request_count?: number
          started_at?: string
          tokens_in?: number
          tokens_out?: number
          user_id?: string
          user_role?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "editor_sessions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      flowstarter_change_requests: {
        Row: {
          classification: string
          completed_at: string | null
          created_at: string
          created_by: string
          currency: string
          id: string
          matched_rules: Json
          message_id: string | null
          paid_at: string | null
          quote_minor: number | null
          quote_note: string | null
          quoted_at: string | null
          quoted_by: string | null
          request: string
          responded_at: string | null
          status: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          classification?: string
          completed_at?: string | null
          created_at?: string
          created_by: string
          currency?: string
          id?: string
          matched_rules?: Json
          message_id?: string | null
          paid_at?: string | null
          quote_minor?: number | null
          quote_note?: string | null
          quoted_at?: string | null
          quoted_by?: string | null
          request: string
          responded_at?: string | null
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          classification?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string
          currency?: string
          id?: string
          matched_rules?: Json
          message_id?: string | null
          paid_at?: string | null
          quote_minor?: number | null
          quote_note?: string | null
          quoted_at?: string | null
          quoted_by?: string | null
          request?: string
          responded_at?: string | null
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flowstarter_change_requests_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "project_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flowstarter_change_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      flowstarter_agent_job_events: {
        Row: {
          actor: string
          body: string
          created_at: string
          id: string
          job_id: string
          kind: string
          payload: Json
          workspace_id: string
        }
        Insert: {
          actor?: string
          body: string
          created_at?: string
          id?: string
          job_id: string
          kind: string
          payload?: Json
          workspace_id: string
        }
        Update: {
          actor?: string
          body?: string
          created_at?: string
          id?: string
          job_id?: string
          kind?: string
          payload?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flowstarter_agent_job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "flowstarter_agent_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flowstarter_agent_job_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      flowstarter_agent_jobs: {
        Row: {
          attempt_count: number
          created_at: string
          error_code: string | null
          error_detail: string | null
          finished_at: string | null
          id: string
          idempotency_key: string | null
          kind: string
          lease_expires_at: string | null
          leased_by: string | null
          max_attempts: number
          payload: Json
          pull_request_url: string | null
          run_after: string
          started_at: string | null
          status: string
          stripe_event_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
          workspace_id: string | null
          worktree_branch: string | null
          worktree_path: string | null
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          error_code?: string | null
          error_detail?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          kind: string
          lease_expires_at?: string | null
          leased_by?: string | null
          max_attempts?: number
          payload?: Json
          pull_request_url?: string | null
          run_after?: string
          started_at?: string | null
          status?: string
          stripe_event_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          workspace_id?: string | null
          worktree_branch?: string | null
          worktree_path?: string | null
        }
        Update: {
          attempt_count?: number
          created_at?: string
          error_code?: string | null
          error_detail?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          kind?: string
          lease_expires_at?: string | null
          leased_by?: string | null
          max_attempts?: number
          payload?: Json
          pull_request_url?: string | null
          run_after?: string
          started_at?: string | null
          status?: string
          stripe_event_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
          workspace_id?: string | null
          worktree_branch?: string | null
          worktree_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flowstarter_agent_jobs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      flowstarter_project_artifacts: {
        Row: {
          brand_config: Json | null
          client_reply_corpus: Json
          created_at: string
          intake_payload: Json
          preview_artifact_url: string | null
          preview_manifest: Json
          scrape_manifest: Json
          template_selection_reason: string | null
          template_slug: string | null
          template_version: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          brand_config?: Json | null
          client_reply_corpus?: Json
          created_at?: string
          intake_payload?: Json
          preview_artifact_url?: string | null
          preview_manifest?: Json
          scrape_manifest?: Json
          template_selection_reason?: string | null
          template_slug?: string | null
          template_version?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          brand_config?: Json | null
          client_reply_corpus?: Json
          created_at?: string
          intake_payload?: Json
          preview_artifact_url?: string | null
          preview_manifest?: Json
          scrape_manifest?: Json
          template_selection_reason?: string | null
          template_slug?: string | null
          template_version?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flowstarter_project_artifacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      funnel_previews: {
        Row: {
          artifact_path: string | null
          brand_config: Json
          claimed_workspace_id: string | null
          created_at: string
          deploy_status: string
          deployment_error: string | null
          expires_at: string
          hostname: string | null
          manifest: Json
          preview_id: string
          template_slug: string | null
          template_version: string | null
          updated_at: string
        }
        Insert: {
          artifact_path?: string | null
          brand_config?: Json
          claimed_workspace_id?: string | null
          created_at?: string
          deploy_status?: string
          deployment_error?: string | null
          expires_at: string
          hostname?: string | null
          manifest?: Json
          preview_id: string
          template_slug?: string | null
          template_version?: string | null
          updated_at?: string
        }
        Update: {
          artifact_path?: string | null
          brand_config?: Json
          claimed_workspace_id?: string | null
          created_at?: string
          deploy_status?: string
          deployment_error?: string | null
          expires_at?: string
          hostname?: string | null
          manifest?: Json
          preview_id?: string
          template_slug?: string | null
          template_version?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "funnel_previews_claimed_workspace_id_fkey"
            columns: ["claimed_workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      hosting_servers: {
        Row: {
          caddy_admin_url: string | null
          cloud_init_version: number
          created_at: string
          created_by: string | null
          decommissioned_at: string | null
          deploy_agent_secret_ref: string | null
          deploy_agent_url: string | null
          hetzner_server_id: string | null
          id: string
          ipv4: unknown
          ipv6: unknown
          location: string
          name: string
          notes: string | null
          provider: string
          server_type: string
          site_capacity: number
          sites_count: number
          status: string
          status_detail: string | null
          updated_at: string
        }
        Insert: {
          caddy_admin_url?: string | null
          cloud_init_version?: number
          created_at?: string
          created_by?: string | null
          decommissioned_at?: string | null
          deploy_agent_secret_ref?: string | null
          deploy_agent_url?: string | null
          hetzner_server_id?: string | null
          id?: string
          ipv4?: unknown
          ipv6?: unknown
          location?: string
          name: string
          notes?: string | null
          provider?: string
          server_type?: string
          site_capacity?: number
          sites_count?: number
          status?: string
          status_detail?: string | null
          updated_at?: string
        }
        Update: {
          caddy_admin_url?: string | null
          cloud_init_version?: number
          created_at?: string
          created_by?: string | null
          decommissioned_at?: string | null
          deploy_agent_secret_ref?: string | null
          deploy_agent_url?: string | null
          hetzner_server_id?: string | null
          id?: string
          ipv4?: unknown
          ipv6?: unknown
          location?: string
          name?: string
          notes?: string | null
          provider?: string
          server_type?: string
          site_capacity?: number
          sites_count?: number
          status?: string
          status_detail?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      funnel_assets: {
        Row: {
          claimed_asset_id: string | null
          claimed_workspace_id: string | null
          created_at: string
          dominant_colors: string[] | null
          height: number | null
          id: string
          kind: string | null
          mime: string | null
          preview_id: string
          rights_confirmed_at: string | null
          rights_ip: string | null
          rights_statement_version: string | null
          rights_user_agent: string | null
          sha256: string | null
          source: string
          storage_path: string | null
          usable_for: string[]
          width: number | null
        }
        Insert: {
          claimed_asset_id?: string | null
          claimed_workspace_id?: string | null
          created_at?: string
          dominant_colors?: string[] | null
          height?: number | null
          id?: string
          kind?: string | null
          mime?: string | null
          preview_id: string
          rights_confirmed_at?: string | null
          rights_ip?: string | null
          rights_statement_version?: string | null
          rights_user_agent?: string | null
          sha256?: string | null
          source?: string
          storage_path?: string | null
          usable_for?: string[]
          width?: number | null
        }
        Update: {
          claimed_asset_id?: string | null
          claimed_workspace_id?: string | null
          created_at?: string
          dominant_colors?: string[] | null
          height?: number | null
          id?: string
          kind?: string | null
          mime?: string | null
          preview_id?: string
          rights_confirmed_at?: string | null
          rights_ip?: string | null
          rights_statement_version?: string | null
          rights_user_agent?: string | null
          sha256?: string | null
          source?: string
          storage_path?: string | null
          usable_for?: string[]
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "funnel_assets_claimed_workspace_id_fkey"
            columns: ["claimed_workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_submissions: {
        Row: {
          created_at: string
          decided_by: string
          id: string
          outcome: string | null
          overridden: boolean
          override_reason: string | null
          payload: Json
          routing_decision: string
          rules_fired: string[]
          score: number | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          decided_by?: string
          id?: string
          outcome?: string | null
          overridden?: boolean
          override_reason?: string | null
          payload?: Json
          routing_decision: string
          rules_fired?: string[]
          score?: number | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          decided_by?: string
          id?: string
          outcome?: string | null
          overridden?: boolean
          override_reason?: string | null
          payload?: Json
          routing_decision?: string
          rules_fired?: string[]
          score?: number | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_submissions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          created_at: string
          email: string | null
          extra: Json
          id: string
          ip_address: string | null
          message: string | null
          name: string | null
          notes: string | null
          phone: string | null
          referrer: string | null
          source: string | null
          status: string
          updated_at: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          extra?: Json
          id?: string
          ip_address?: string | null
          message?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          referrer?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          extra?: Json
          id?: string
          ip_address?: string | null
          message?: string | null
          name?: string | null
          notes?: string | null
          phone?: string | null
          referrer?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_usage: {
        Row: {
          action: string
          cached_tokens: number
          cost_estimate: number | null
          created_at: string
          id: string
          model: string | null
          project_id: string | null
          tokens_in: number
          tokens_out: number
          workspace_id: string | null
        }
        Insert: {
          action: string
          cached_tokens?: number
          cost_estimate?: number | null
          created_at?: string
          id?: string
          model?: string | null
          project_id?: string | null
          tokens_in?: number
          tokens_out?: number
          workspace_id?: string | null
        }
        Update: {
          action?: string
          cached_tokens?: number
          cost_estimate?: number | null
          created_at?: string
          id?: string
          model?: string | null
          project_id?: string | null
          tokens_in?: number
          tokens_out?: number
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "llm_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_alerts: {
        Row: {
          created_at: string
          dedupe_key: string
          detail: Json
          event: string
          first_seen_at: string
          id: string
          last_sent_at: string
          occurrence_count: number
          severity: string
          title: string
          updated_at: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          dedupe_key: string
          detail?: Json
          event: string
          first_seen_at?: string
          id?: string
          last_sent_at?: string
          occurrence_count?: number
          severity: string
          title: string
          updated_at?: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          dedupe_key?: string
          detail?: Json
          event?: string
          first_seen_at?: string
          id?: string
          last_sent_at?: string
          occurrence_count?: number
          severity?: string
          title?: string
          updated_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ops_alerts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          clerk_user_id: string
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          clerk_user_id: string
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          clerk_user_id?: string
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      project_events: {
        Row: {
          actor: string
          created_at: string
          id: string
          kind: string
          payload: Json
          workspace_id: string
        }
        Insert: {
          actor?: string
          created_at?: string
          id?: string
          kind: string
          payload?: Json
          workspace_id: string
        }
        Update: {
          actor?: string
          created_at?: string
          id?: string
          kind?: string
          payload?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      project_messages: {
        Row: {
          answered_at: string | null
          asks: Json
          body: string | null
          created_at: string
          created_by: string | null
          direction: string
          id: string
          kind: string
          sent_at: string | null
          status: string
          workspace_id: string
        }
        Insert: {
          answered_at?: string | null
          asks?: Json
          body?: string | null
          created_at?: string
          created_by?: string | null
          direction: string
          id?: string
          kind: string
          sent_at?: string | null
          status?: string
          workspace_id: string
        }
        Update: {
          answered_at?: string | null
          asks?: Json
          body?: string | null
          created_at?: string
          created_by?: string | null
          direction?: string
          id?: string
          kind?: string
          sent_at?: string | null
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_messages_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      setup_payment_milestones: {
        Row: {
          amount_minor: number
          approved_at: string | null
          created_at: string
          currency: string
          id: string
          milestone: string
          paid_at: string | null
          position: number
          status: string
          stripe_invoice_id: string | null
          stripe_invoice_url: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          amount_minor: number
          approved_at?: string | null
          created_at?: string
          currency?: string
          id?: string
          milestone: string
          paid_at?: string | null
          position: number
          status?: string
          stripe_invoice_id?: string | null
          stripe_invoice_url?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          amount_minor?: number
          approved_at?: string | null
          created_at?: string
          currency?: string
          id?: string
          milestone?: string
          paid_at?: string | null
          position?: number
          status?: string
          stripe_invoice_id?: string | null
          stripe_invoice_url?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "setup_payment_milestones_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      site_versions: {
        Row: {
          created_at: string
          created_by: string
          id: string
          manifest: Json
          published_at: string | null
          summary: string | null
          version: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          id?: string
          manifest: Json
          published_at?: string | null
          summary?: string | null
          version: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          manifest?: Json
          published_at?: string | null
          summary?: string | null
          version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_versions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          attempts: number
          created: string
          id: string
          last_error: string | null
          object_id: string | null
          outcome: string | null
          processed_at: string | null
          received_at: string
          type: string
        }
        Insert: {
          attempts?: number
          created: string
          id: string
          last_error?: string | null
          object_id?: string | null
          outcome?: string | null
          processed_at?: string | null
          received_at?: string
          type: string
        }
        Update: {
          attempts?: number
          created?: string
          id?: string
          last_error?: string | null
          object_id?: string | null
          outcome?: string | null
          processed_at?: string | null
          received_at?: string
          type?: string
        }
        Relationships: []
      }
      vault_encrypted_secrets: {
        Row: {
          created_at: string
          encrypted_value: string
          id: string
          secret_name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          encrypted_value: string
          id?: string
          secret_name: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          encrypted_value?: string
          id?: string
          secret_name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vault_encrypted_secrets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_billing_profiles: {
        Row: {
          bill_to_company: boolean
          billing_address: string | null
          company_name: string | null
          country: string | null
          created_at: string
          registration_no: string | null
          updated_at: string
          vat_id: string | null
          workspace_id: string
        }
        Insert: {
          bill_to_company?: boolean
          billing_address?: string | null
          company_name?: string | null
          country?: string | null
          created_at?: string
          registration_no?: string | null
          updated_at?: string
          vat_id?: string | null
          workspace_id: string
        }
        Update: {
          bill_to_company?: boolean
          billing_address?: string | null
          company_name?: string | null
          country?: string | null
          created_at?: string
          registration_no?: string | null
          updated_at?: string
          vat_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_billing_profiles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_bookings: {
        Row: {
          attendee_email: string | null
          attendee_name: string | null
          created_at: string
          end_at: string | null
          event_type_slug: string | null
          external_uid: string
          id: string
          payload: Json
          provider: string
          start_at: string | null
          status: string
          title: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attendee_email?: string | null
          attendee_name?: string | null
          created_at?: string
          end_at?: string | null
          event_type_slug?: string | null
          external_uid: string
          id?: string
          payload?: Json
          provider?: string
          start_at?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attendee_email?: string | null
          attendee_name?: string | null
          created_at?: string
          end_at?: string | null
          event_type_slug?: string | null
          external_uid?: string
          id?: string
          payload?: Json
          provider?: string
          start_at?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_bookings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_briefs: {
        Row: {
          created_at: string
          design_reference_asset_ids: string[]
          no_projects: boolean
          offer: string
          override_at: string | null
          override_by: string | null
          palette: Json
          photo_asset_ids: string[]
          projects: Json
          ready_at: string | null
          tone: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          design_reference_asset_ids?: string[]
          no_projects?: boolean
          offer?: string
          override_at?: string | null
          override_by?: string | null
          palette?: Json
          photo_asset_ids?: string[]
          projects?: Json
          ready_at?: string | null
          tone?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          design_reference_asset_ids?: string[]
          no_projects?: boolean
          offer?: string
          override_at?: string | null
          override_by?: string | null
          palette?: Json
          photo_asset_ids?: string[]
          projects?: Json
          ready_at?: string | null
          tone?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_briefs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_hosts: {
        Row: {
          created_at: string
          hostname: string
          is_primary: boolean
          workspace_id: string
        }
        Insert: {
          created_at?: string
          hostname: string
          is_primary?: boolean
          workspace_id: string
        }
        Update: {
          created_at?: string
          hostname?: string
          is_primary?: boolean
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_hosts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_memberships: {
        Row: {
          clerk_user_id: string
          created_at: string
          role: string
          workspace_id: string
        }
        Insert: {
          clerk_user_id: string
          created_at?: string
          role: string
          workspace_id: string
        }
        Update: {
          clerk_user_id?: string
          created_at?: string
          role?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_memberships_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          balance_payment_intent_id: string | null
          balance_percent: number
          billing_currency: string
          billing_interval: string
          cal_com_url: string | null
          cal_com_webhook_secret: string | null
          claimed_preview_id: string | null
          client_business_name: string | null
          client_email: string | null
          client_name: string | null
          client_phone: string | null
          cloudflare_record_ids: Json
          cloudflare_zone_id: string | null
          commerce_mode: string
          commerce_notes: string | null
          commerce_product_count: number
          commerce_product_type: string
          commerce_provider: string
          commerce_requirements: Json
          commerce_status: string
          concierge_stage: string
          created_at: string
          deploy_status: string
          deposit_amount: number | null
          deposit_invoice_id: string | null
          deposit_invoice_url: string | null
          deposit_paid_at: string | null
          deposit_payment_intent_id: string | null
          deposit_percent: number
          deposit_status: string
          editor_repo_ref: string
          editor_repo_url: string | null
          final_amount: number | null
          final_invoice_id: string | null
          final_invoice_url: string | null
          final_paid_at: string | null
          final_status: string
          final_value_minor: number | null
          founding_locked_until: string | null
          hosting_server_id: string | null
          id: string
          is_founding: boolean
          last_deploy_id: string | null
          last_deployed_at: string | null
          lead_capture_token: string
          monthly_fee: number | null
          name: string
          outstanding_payment: boolean
          project_state: string
          setup_fee: number | null
          setup_go_live_at: string | null
          setup_mockup_approved_at: string | null
          setup_signed_at: string | null
          setup_staging_ready_at: string | null
          site_directory: string | null
          site_kind: string
          slug: string
          ssl_issued_at: string | null
          ssl_status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_ai_cost_usd_this_month: number
          subscription_next_billing: string | null
          subscription_rollover_remaining: number
          subscription_sessions_used_this_month: number
          subscription_status: string | null
          subscription_trial_ends: string | null
          subscription_usage_period_start: string
          tier_name: string | null
          updated_at: string
        }
        Insert: {
          balance_payment_intent_id?: string | null
          balance_percent?: number
          billing_currency?: string
          billing_interval?: string
          cal_com_url?: string | null
          cal_com_webhook_secret?: string | null
          claimed_preview_id?: string | null
          client_business_name?: string | null
          client_email?: string | null
          client_name?: string | null
          client_phone?: string | null
          cloudflare_record_ids?: Json
          cloudflare_zone_id?: string | null
          commerce_mode?: string
          commerce_notes?: string | null
          commerce_product_count?: number
          commerce_product_type?: string
          commerce_provider?: string
          commerce_requirements?: Json
          commerce_status?: string
          concierge_stage?: string
          created_at?: string
          deploy_status?: string
          deposit_amount?: number | null
          deposit_invoice_id?: string | null
          deposit_invoice_url?: string | null
          deposit_paid_at?: string | null
          deposit_payment_intent_id?: string | null
          deposit_percent?: number
          deposit_status?: string
          editor_repo_ref?: string
          editor_repo_url?: string | null
          final_amount?: number | null
          final_invoice_id?: string | null
          final_invoice_url?: string | null
          final_paid_at?: string | null
          final_status?: string
          final_value_minor?: number | null
          founding_locked_until?: string | null
          hosting_server_id?: string | null
          id?: string
          is_founding?: boolean
          last_deploy_id?: string | null
          last_deployed_at?: string | null
          lead_capture_token?: string
          monthly_fee?: number | null
          name: string
          outstanding_payment?: boolean
          project_state?: string
          setup_fee?: number | null
          setup_go_live_at?: string | null
          setup_mockup_approved_at?: string | null
          setup_signed_at?: string | null
          setup_staging_ready_at?: string | null
          site_directory?: string | null
          site_kind: string
          slug: string
          ssl_issued_at?: string | null
          ssl_status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_ai_cost_usd_this_month?: number
          subscription_next_billing?: string | null
          subscription_rollover_remaining?: number
          subscription_sessions_used_this_month?: number
          subscription_status?: string | null
          subscription_trial_ends?: string | null
          subscription_usage_period_start?: string
          tier_name?: string | null
          updated_at?: string
        }
        Update: {
          balance_payment_intent_id?: string | null
          balance_percent?: number
          billing_currency?: string
          billing_interval?: string
          cal_com_url?: string | null
          cal_com_webhook_secret?: string | null
          claimed_preview_id?: string | null
          client_business_name?: string | null
          client_email?: string | null
          client_name?: string | null
          client_phone?: string | null
          cloudflare_record_ids?: Json
          cloudflare_zone_id?: string | null
          commerce_mode?: string
          commerce_notes?: string | null
          commerce_product_count?: number
          commerce_product_type?: string
          commerce_provider?: string
          commerce_requirements?: Json
          commerce_status?: string
          concierge_stage?: string
          created_at?: string
          deploy_status?: string
          deposit_amount?: number | null
          deposit_invoice_id?: string | null
          deposit_invoice_url?: string | null
          deposit_paid_at?: string | null
          deposit_payment_intent_id?: string | null
          deposit_percent?: number
          deposit_status?: string
          editor_repo_ref?: string
          editor_repo_url?: string | null
          final_amount?: number | null
          final_invoice_id?: string | null
          final_invoice_url?: string | null
          final_paid_at?: string | null
          final_status?: string
          final_value_minor?: number | null
          founding_locked_until?: string | null
          hosting_server_id?: string | null
          id?: string
          is_founding?: boolean
          last_deploy_id?: string | null
          last_deployed_at?: string | null
          lead_capture_token?: string
          monthly_fee?: number | null
          name?: string
          outstanding_payment?: boolean
          project_state?: string
          setup_fee?: number | null
          setup_go_live_at?: string | null
          setup_mockup_approved_at?: string | null
          setup_signed_at?: string | null
          setup_staging_ready_at?: string | null
          site_directory?: string | null
          site_kind?: string
          slug?: string
          ssl_issued_at?: string | null
          ssl_status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_ai_cost_usd_this_month?: number
          subscription_next_billing?: string | null
          subscription_rollover_remaining?: number
          subscription_sessions_used_this_month?: number
          subscription_status?: string | null
          subscription_trial_ends?: string | null
          subscription_usage_period_start?: string
          tier_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_hosting_server_id_fkey"
            columns: ["hosting_server_id"]
            isOneToOne: false
            referencedRelation: "hosting_servers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspaces_last_deploy_fk"
            columns: ["last_deploy_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_workspace_ai_cost_usd: {
        Args: { p_usd: number; p_workspace_id: string }
        Returns: undefined
      }
      current_clerk_user_id: { Args: never; Returns: string }
      increment_workspace_sessions_used: {
        Args: { p_workspace_id: string }
        Returns: undefined
      }
      is_workspace_member: { Args: { ws: string }; Returns: boolean }
      tenant_path_workspace_id: {
        Args: { object_name: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

