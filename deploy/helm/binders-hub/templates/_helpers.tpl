{{- define "hub.name" -}}{{ .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}

{{- define "hub.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "hub.ownLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ include "hub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* A resource's labels: the chart's own, then `extra`, then commonLabels. Called with (list . extra). */}}
{{- define "hub.labelsWith" -}}
{{- $ctx := index . 0 -}}
{{- toYaml (merge (fromYaml (include "hub.ownLabels" $ctx)) (index . 1) ($ctx.Values.commonLabels | default dict)) -}}
{{- end -}}

{{- define "hub.labels" -}}{{ include "hub.labelsWith" (list . dict) }}{{- end -}}

{{/* A pod's labels: what its selector picks, then `extra`, then commonLabels. Called with (list . extra). */}}
{{- define "hub.podLabels" -}}
{{- $ctx := index . 0 -}}
{{- toYaml (merge (fromYaml (include "hub.selector" $ctx)) (index . 1) ($ctx.Values.commonLabels | default dict)) -}}
{{- end -}}

{{- define "hub.selector" -}}
app.kubernetes.io/name: {{ include "hub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The pull secrets the pods use: those named, and the chart's own when it makes one. A name alone works as well as {name: …}. */}}
{{- define "hub.imagePullSecrets" -}}
{{- $names := list -}}
{{- range .Values.imagePullSecrets -}}
{{- if kindIs "string" . -}}{{- $names = append $names . -}}{{- else -}}{{- $names = append $names .name -}}{{- end -}}
{{- end -}}
{{- if .Values.imageCredentials.registry -}}
{{- $names = append $names (printf "%s-registry" (include "hub.fullname" .)) -}}
{{- end -}}
{{- with $names }}
imagePullSecrets:
{{- range . }}
  - name: {{ . | quote }}
{{- end }}
{{- end -}}
{{- end -}}

{{- define "hub.secretName" -}}
{{- .Values.hubSecret.existingSecret | default (printf "%s-secret" (include "hub.fullname" .)) -}}
{{- end -}}

{{- define "hub.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ .Values.serviceAccount.name | default (include "hub.fullname" .) }}
{{- else -}}{{ .Values.serviceAccount.name }}{{- end -}}
{{- end -}}
